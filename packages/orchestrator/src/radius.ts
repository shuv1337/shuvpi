import { hostname, platform } from "node:os";
import { AuthStorage, type OAuthCredential } from "@shuv1337/shuvpi-coding-agent";
import { getOrchestratorDir, getSocketPath, VERSION } from "./config.ts";
import { loadMachine, saveMachine } from "./storage.ts";
import type { InstanceRecord, MachineRecord, RadiusRegistration } from "./types.ts";

const DEFAULT_RADIUS_URL = "https://radius.pi.dev/";
const DEFAULT_ORCHESTRATOR_BASE_PATH = "/v1/";
const NOT_FOUND_RETRY_THRESHOLD = 3;
const HEARTBEAT_BACKOFF_BASE_MS = 1_000;
const HEARTBEAT_BACKOFF_MAX_MS = 30_000;
const RADIUS_PROVIDER = "radius";

interface RegisterMachineResponse extends RadiusRegistration {
	id: string;
}

interface RegisterShuvpiResponse extends RadiusRegistration {
	id: string;
}

interface RadiusPresenceCoordinator {
	getLiveInstance(instanceId: string): InstanceRecord | undefined;
	listLiveInstances(): InstanceRecord[];
	updateInstance(instance: InstanceRecord): void;
}

interface ShuvpiHeartbeatState {
	timer?: NodeJS.Timeout;
	intervalMs: number;
	radiusShuvpiId: string;
	consecutiveNotFoundCount: number;
	transientFailureCount: number;
}

class RadiusHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RadiusHttpError";
		this.status = status;
	}
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusAccessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new RadiusHttpError(response.status, `Radius request failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as T;
}

async function maybePost(path: string, body: unknown): Promise<void> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusAccessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new RadiusHttpError(response.status, `Radius request failed: ${response.status} ${await response.text()}`);
	}
}

function isNotFoundError(error: unknown): error is RadiusHttpError {
	return error instanceof RadiusHttpError && error.status === 404;
}

function computeBackoffDelayMs(failureCount: number): number {
	const exponentialDelay = Math.min(
		HEARTBEAT_BACKOFF_MAX_MS,
		HEARTBEAT_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
	);
	const jitterMs = Math.floor(Math.random() * Math.max(250, exponentialDelay / 4));
	return Math.min(HEARTBEAT_BACKOFF_MAX_MS, exponentialDelay + jitterMs);
}

function formatRadiusError(error: unknown): string {
	if (error instanceof RadiusHttpError) {
		return `HTTP ${error.status}: ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function logRadiusRetry(scope: string, action: string, delayMs: number, failureCount: number, error: unknown): void {
	console.error(
		`${scope} ${action} failed (attempt ${failureCount}); retrying in ${delayMs}ms: ${formatRadiusError(error)}`,
	);
}

export function getRadiusUrl(): string {
	return process.env.SHUVPI_RADIUS_URL || DEFAULT_RADIUS_URL;
}

export function getRadiusOrchestratorBaseUrl(): string {
	const explicitUrl = process.env.SHUVPI_RADIUS_ORCHESTRATOR_URL;
	if (explicitUrl) {
		return explicitUrl;
	}

	return new URL(DEFAULT_ORCHESTRATOR_BASE_PATH, getRadiusUrl()).toString();
}

const radiusAuthStorage = AuthStorage.create();

function getStoredRadiusCredential(): OAuthCredential | undefined {
	radiusAuthStorage.reload();
	const credential = radiusAuthStorage.get(RADIUS_PROVIDER);
	if (!credential || credential.type !== "oauth") {
		return undefined;
	}
	return credential;
}

export function getRadiusAccessToken(): string {
	const storedCredential = getStoredRadiusCredential();
	if (typeof storedCredential?.access === "string" && storedCredential.access) {
		return storedCredential.access;
	}

	const apiKey = process.env.SHUVPI_RADIUS_API_KEY;
	if (apiKey) {
		return apiKey;
	}

	throw new Error("Radius credentials are required in ~/.shuvpi/agent/auth.json or SHUVPI_RADIUS_API_KEY");
}

export function isRadiusEnabled(): boolean {
	return !!getStoredRadiusCredential()?.access || !!process.env.SHUVPI_RADIUS_API_KEY;
}

export class RadiusPresence {
	private machineHeartbeatTimer?: NodeJS.Timeout;
	private machineHeartbeatIntervalMs = 0;
	private machineConsecutiveNotFoundCount = 0;
	private machineTransientFailureCount = 0;
	private readonly shuvpiHeartbeatStates = new Map<string, ShuvpiHeartbeatState>();
	private machine?: MachineRecord;
	private coordinator?: RadiusPresenceCoordinator;

	setCoordinator(coordinator: RadiusPresenceCoordinator): void {
		this.coordinator = coordinator;
	}

	async start(label?: string): Promise<MachineRecord | undefined> {
		if (!isRadiusEnabled()) {
			return undefined;
		}

		const registered = await this.registerMachine(label);
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);
		return this.machine;
	}

	async stop(): Promise<void> {
		if (this.machineHeartbeatTimer) {
			clearTimeout(this.machineHeartbeatTimer);
			this.machineHeartbeatTimer = undefined;
		}
		for (const [instanceId, state] of this.shuvpiHeartbeatStates) {
			if (state.timer) {
				clearTimeout(state.timer);
			}
			this.shuvpiHeartbeatStates.delete(instanceId);
		}
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}
		try {
			await maybePost(`machines/${this.machine.id}/disconnect`, {});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	async registerInstance(instance: InstanceRecord): Promise<InstanceRecord> {
		if (!isRadiusEnabled()) {
			return instance;
		}
		const machine = this.machine ?? loadMachine();
		if (!machine) {
			throw new Error("No registered machine available for Shuvpi registration");
		}
		const registered = await post<RegisterShuvpiResponse>("pis/register", {
			machineId: machine.id,
			label: instance.label,
			cwd: instance.cwd,
			hostname: hostname(),
			pid: process.pid,
			transport: "local-rpc",
			capabilities: { rpc: true, relay: false, iroh: false },
			sessionId: instance.sessionId,
		});
		const registeredInstance = { ...instance, radiusShuvpiId: registered.id };
		this.startShuvpiHeartbeat(instance.id, registered.heartbeatIntervalMs, registered.id);
		return registeredInstance;
	}

	async disconnectInstance(instance: InstanceRecord): Promise<void> {
		const state = this.shuvpiHeartbeatStates.get(instance.id);
		if (state) {
			if (state.timer) {
				clearTimeout(state.timer);
			}
			this.shuvpiHeartbeatStates.delete(instance.id);
		}
		if (!isRadiusEnabled() || !instance.radiusShuvpiId) {
			return;
		}
		try {
			await maybePost(`pis/${instance.radiusShuvpiId}/disconnect`, {});
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	private async registerMachine(label?: string): Promise<RegisterMachineResponse> {
		const existingMachine = this.machine ?? loadMachine();
		const registered = await post<RegisterMachineResponse>("machines/register", {
			machineId: existingMachine?.id,
			label,
			hostname: hostname(),
			platform: platform(),
			arch: process.arch,
			version: VERSION,
			capabilities: { spawn: true, relay: false, iroh: false },
		});

		const timestamp = new Date().toISOString();
		this.machine = {
			id: registered.id,
			createdAt: existingMachine?.createdAt ?? timestamp,
			lastSeenAt: timestamp,
			label,
		};
		saveMachine(this.machine);
		this.machineConsecutiveNotFoundCount = 0;
		this.machineTransientFailureCount = 0;
		return registered;
	}

	private startMachineHeartbeat(intervalMs: number): void {
		this.machineHeartbeatIntervalMs = intervalMs;
		this.scheduleMachineHeartbeat(intervalMs);
	}

	private scheduleMachineHeartbeat(delayMs: number): void {
		if (this.machineHeartbeatTimer) {
			clearTimeout(this.machineHeartbeatTimer);
		}
		this.machineHeartbeatTimer = setTimeout(() => {
			void this.heartbeatMachine();
		}, delayMs);
	}

	private startShuvpiHeartbeat(instanceId: string, intervalMs: number, radiusShuvpiId: string): void {
		const existingState = this.shuvpiHeartbeatStates.get(instanceId);
		if (existingState?.timer) {
			clearTimeout(existingState.timer);
		}
		const state: ShuvpiHeartbeatState = existingState ?? {
			intervalMs,
			radiusShuvpiId,
			consecutiveNotFoundCount: 0,
			transientFailureCount: 0,
		};
		state.intervalMs = intervalMs;
		state.radiusShuvpiId = radiusShuvpiId;
		state.consecutiveNotFoundCount = 0;
		state.transientFailureCount = 0;
		this.shuvpiHeartbeatStates.set(instanceId, state);
		this.scheduleShuvpiHeartbeat(instanceId, intervalMs);
	}

	private scheduleShuvpiHeartbeat(instanceId: string, delayMs: number): void {
		const state = this.shuvpiHeartbeatStates.get(instanceId);
		if (!state) {
			return;
		}
		if (state.timer) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			void this.heartbeatInstance(instanceId);
		}, delayMs);
	}

	private async heartbeatMachine(): Promise<void> {
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}

		try {
			await maybePost(`machines/${this.machine.id}/heartbeat`, {
				cwd: getOrchestratorDir(),
				socketPath: getSocketPath(),
			});
			this.machineConsecutiveNotFoundCount = 0;
			this.machineTransientFailureCount = 0;
			this.scheduleMachineHeartbeat(this.machineHeartbeatIntervalMs);
		} catch (error) {
			if (!isNotFoundError(error)) {
				this.machineTransientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(this.machineTransientFailureCount);
				logRadiusRetry("Radius machine", "heartbeat", delayMs, this.machineTransientFailureCount, error);
				this.scheduleMachineHeartbeat(delayMs);
				return;
			}

			this.machineTransientFailureCount = 0;
			this.machineConsecutiveNotFoundCount += 1;
			if (this.machineConsecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				this.scheduleMachineHeartbeat(this.machineHeartbeatIntervalMs);
				return;
			}

			try {
				await this.reRegisterMachineAndInstances();
			} catch (recoveryError) {
				this.machineTransientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(this.machineTransientFailureCount);
				logRadiusRetry(
					"Radius machine",
					"re-registration",
					delayMs,
					this.machineTransientFailureCount,
					recoveryError,
				);
				this.scheduleMachineHeartbeat(delayMs);
			}
		}
	}

	private async heartbeatInstance(instanceId: string): Promise<void> {
		if (!isRadiusEnabled()) {
			return;
		}

		const state = this.shuvpiHeartbeatStates.get(instanceId);
		if (!state) {
			return;
		}

		try {
			await maybePost(`pis/${state.radiusShuvpiId}/heartbeat`, {});
			state.consecutiveNotFoundCount = 0;
			state.transientFailureCount = 0;
			this.scheduleShuvpiHeartbeat(instanceId, state.intervalMs);
		} catch (error) {
			if (!isNotFoundError(error)) {
				state.transientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(state.transientFailureCount);
				logRadiusRetry(`Radius Shuvpi ${instanceId}`, "heartbeat", delayMs, state.transientFailureCount, error);
				this.scheduleShuvpiHeartbeat(instanceId, delayMs);
				return;
			}

			state.transientFailureCount = 0;
			state.consecutiveNotFoundCount += 1;
			if (state.consecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				this.scheduleShuvpiHeartbeat(instanceId, state.intervalMs);
				return;
			}

			try {
				const recovered = await this.reRegisterInstance(instanceId);
				if (!recovered) {
					const delayMs = computeBackoffDelayMs(1);
					console.error(`Radius Shuvpi ${instanceId} re-registration skipped; retrying in ${delayMs}ms`);
					this.scheduleShuvpiHeartbeat(instanceId, delayMs);
				}
			} catch (recoveryError) {
				state.transientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(state.transientFailureCount);
				logRadiusRetry(
					`Radius Shuvpi ${instanceId}`,
					"re-registration",
					delayMs,
					state.transientFailureCount,
					recoveryError,
				);
				this.scheduleShuvpiHeartbeat(instanceId, delayMs);
			}
		}
	}

	private async reRegisterMachineAndInstances(): Promise<void> {
		const registered = await this.registerMachine(this.machine?.label);
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);

		const instances = this.coordinator?.listLiveInstances() ?? [];
		for (const instance of instances) {
			try {
				await this.reRegisterInstance(instance.id);
			} catch (error) {
				console.error(`Radius Shuvpi ${instance.id} re-registration failed: ${formatRadiusError(error)}`);
			}
		}
	}

	private async reRegisterInstance(instanceId: string): Promise<boolean> {
		const instance = this.coordinator?.getLiveInstance(instanceId);
		if (!instance) {
			const state = this.shuvpiHeartbeatStates.get(instanceId);
			if (state) {
				if (state.timer) {
					clearTimeout(state.timer);
				}
				this.shuvpiHeartbeatStates.delete(instanceId);
			}
			return false;
		}

		if (!this.machine) {
			await this.reRegisterMachineAndInstances();
			return true;
		}

		const registeredInstance = await this.registerInstance(instance);
		this.coordinator?.updateInstance(registeredInstance);
		return true;
	}
}

export const radiusPresence = new RadiusPresence();
