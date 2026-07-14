import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { getModels, getProviders, type Model, modelsAreEqual } from "@shuv1337/shuvpi-ai/compat";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Image as ImageIcon, Star } from "lucide";
import { Input } from "../components/Input.ts";
import { getAppStorage } from "../storage/app-storage.ts";
import type { AutoDiscoveryProviderType } from "../storage/stores/custom-providers-store.ts";
import { formatModelCost } from "../utils/format.ts";
import { i18n } from "../utils/i18n.ts";
import { discoverModels } from "../utils/model-discovery.ts";

const MODEL_FAVORITES_SETTINGS_KEY = "modelSelector.favoriteModels";

type ModelEntry = {
	provider: string;
	id: string;
	model: Model<any>;
	searchScore?: number;
};

/**
 * Score a query against a text using subsequence matching.
 * All query characters must appear in order in the text.
 * Higher score = tighter match (fewer gaps between matched characters).
 * Returns 0 if no match.
 */
function subsequenceScore(query: string, text: string): number {
	let qi = 0;
	let ti = 0;
	let gaps = 0;
	let lastMatchIndex = -1;

	while (qi < query.length && ti < text.length) {
		if (query[qi] === text[ti]) {
			if (lastMatchIndex >= 0) {
				gaps += ti - lastMatchIndex - 1;
			}
			lastMatchIndex = ti;
			qi++;
		}
		ti++;
	}

	// All query chars must match
	if (qi < query.length) return 0;

	// Score: longer query match = better, fewer gaps = better
	// Normalize so exact substring gets highest score
	return query.length / (query.length + gaps);
}

function getModelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

@customElement("agent-model-selector")
export class ModelSelector extends DialogBase {
	@state() currentModel: Model<any> | null = null;
	@state() searchQuery = "";
	@state() filterThinking = false;
	@state() filterVision = false;
	@state() customProvidersLoading = false;
	@state() selectedIndex = 0;
	@state() private navigationMode: "mouse" | "keyboard" = "mouse";
	@state() private customProviderModels: Model<any>[] = [];
	@state() private favoriteModelKeys: string[] = [];

	private onSelectCallback?: (model: Model<any>) => void;
	private allowedProviders?: Set<string>;
	private scrollContainerRef = createRef<HTMLDivElement>();
	private searchInputRef = createRef<HTMLInputElement>();
	private lastMousePosition = { x: 0, y: 0 };

	protected override modalWidth = "min(460px, 92vw)";

	static async open(
		currentModel: Model<any> | null,
		onSelect: (model: Model<any>) => void,
		allowedProviders?: string[],
	) {
		const selector = new ModelSelector();
		selector.currentModel = currentModel;
		selector.onSelectCallback = onSelect;
		if (allowedProviders) {
			selector.allowedProviders = new Set(allowedProviders);
		}
		selector.open();
		selector.loadFavoriteModels();
		selector.loadCustomProviders();
	}

	override async firstUpdated(changedProperties: PropertyValues): Promise<void> {
		super.firstUpdated(changedProperties);
		// Wait for dialog to be fully rendered
		await this.updateComplete;
		// Focus the search input when dialog opens
		this.searchInputRef.value?.focus();

		// Track actual mouse movement
		this.addEventListener("mousemove", (e: MouseEvent) => {
			// Check if mouse actually moved
			if (e.clientX !== this.lastMousePosition.x || e.clientY !== this.lastMousePosition.y) {
				this.lastMousePosition = { x: e.clientX, y: e.clientY };
				// Only switch to mouse mode on actual mouse movement
				if (this.navigationMode === "keyboard") {
					this.navigationMode = "mouse";
					// Update selection to the item under the mouse
					const target = e.target as HTMLElement;
					const modelItem = target.closest("[data-model-item]");
					if (modelItem) {
						const allItems = this.scrollContainerRef.value?.querySelectorAll("[data-model-item]");
						if (allItems) {
							const index = Array.from(allItems).indexOf(modelItem);
							if (index !== -1) {
								this.selectedIndex = index;
							}
						}
					}
				}
			}
		});

		// Add global keyboard handler for the dialog
		this.addEventListener("keydown", (e: KeyboardEvent) => {
			// Ignore key events during IME composition (e.g. CJK input)
			if (e.isComposing || e.key === "Process") return;

			// Get filtered models to know the bounds
			const filteredModels = this.getFilteredModels();

			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.min(this.selectedIndex + 1, filteredModels.length - 1);
				this.scrollToSelected();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.navigationMode = "keyboard";
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				this.scrollToSelected();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (filteredModels[this.selectedIndex]) {
					this.handleSelect(filteredModels[this.selectedIndex].model);
				}
			}
		});
	}

	private async loadFavoriteModels() {
		try {
			const storage = getAppStorage();
			const favoriteModels = await storage.settings.get<string[]>(MODEL_FAVORITES_SETTINGS_KEY);
			this.favoriteModelKeys = Array.isArray(favoriteModels) ? favoriteModels : [];
		} catch (error) {
			console.error("Failed to load favorite models:", error);
			this.favoriteModelKeys = [];
		}
	}

	private async toggleFavorite(model: Model<any>) {
		const modelKey = getModelKey(model.provider, model.id);
		const isFavorite = this.favoriteModelKeys.includes(modelKey);
		const nextFavoriteModelKeys = isFavorite
			? this.favoriteModelKeys.filter((key) => key !== modelKey)
			: [...this.favoriteModelKeys, modelKey];

		this.favoriteModelKeys = nextFavoriteModelKeys;

		try {
			const storage = getAppStorage();
			await storage.settings.set(MODEL_FAVORITES_SETTINGS_KEY, nextFavoriteModelKeys);
		} catch (error) {
			console.error("Failed to save favorite models:", error);
		}
	}

	private isFavorite(model: Model<any>): boolean {
		return this.favoriteModelKeys.includes(getModelKey(model.provider, model.id));
	}

	private async loadCustomProviders() {
		this.customProvidersLoading = true;
		const allCustomModels: Model<any>[] = [];

		try {
			const storage = getAppStorage();
			const customProviders = await storage.customProviders.getAll();

			// Load models from custom providers
			for (const provider of customProviders) {
				const modelsById = new Map<string, Model<any>>();
				const isAutoDiscovery: boolean =
					!provider.disableDiscovery &&
					(provider.type === "ollama" ||
						provider.type === "llama.cpp" ||
						provider.type === "vllm" ||
						provider.type === "lmstudio" ||
						provider.type === "openai-completions" ||
						provider.type === "openai-responses");

				if (provider.models) {
					for (const model of provider.models) {
						modelsById.set(model.id, {
							...model,
							provider: provider.name,
						});
					}
				}

				if (isAutoDiscovery) {
					try {
						const models = await discoverModels(
							provider.type as AutoDiscoveryProviderType,
							provider.baseUrl,
							provider.apiKey,
						);

						for (const model of models) {
							if (modelsById.has(model.id)) continue;
							modelsById.set(model.id, {
								...model,
								provider: provider.name,
							});
						}
					} catch (error) {
						console.debug(`Failed to load models from ${provider.name}:`, error);
					}
				}

				allCustomModels.push(...modelsById.values());
			}
		} catch (error) {
			console.error("Failed to load custom providers:", error);
		} finally {
			this.customProviderModels = allCustomModels;
			this.customProvidersLoading = false;
			this.requestUpdate();
		}
	}

	private formatTokens(tokens: number): string {
		if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
		if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}`;
		return String(tokens);
	}

	private handleSelect(model: Model<any>) {
		if (model) {
			this.onSelectCallback?.(model);
			this.close();
		}
	}

	private compareEntries(a: ModelEntry, b: ModelEntry): number {
		const aIsFavorite = this.isFavorite(a.model);
		const bIsFavorite = this.isFavorite(b.model);
		if (aIsFavorite !== bIsFavorite) return aIsFavorite ? -1 : 1;

		const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
		const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
		if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;

		const scoreDelta = (b.searchScore ?? 0) - (a.searchScore ?? 0);
		if (scoreDelta !== 0) return scoreDelta;

		const providerDelta = a.provider.localeCompare(b.provider);
		if (providerDelta !== 0) return providerDelta;

		return a.id.localeCompare(b.id);
	}

	private getFilteredModels(): ModelEntry[] {
		// Collect all models from known providers
		const allModels: ModelEntry[] = [];
		const knownProviders = getProviders();

		for (const provider of knownProviders) {
			const models = getModels(provider as any);
			for (const model of models) {
				allModels.push({ provider, id: model.id, model });
			}
		}

		// Add custom provider models
		for (const model of this.customProviderModels) {
			allModels.push({ provider: model.provider, id: model.id, model });
		}

		// Filter by allowed providers if set
		let filteredModels = this.allowedProviders
			? allModels.filter(({ provider }) => this.allowedProviders?.has(provider))
			: allModels;

		// Apply capability filters
		if (this.filterThinking) {
			filteredModels = filteredModels.filter(({ model }) => model.reasoning);
		}
		if (this.filterVision) {
			filteredModels = filteredModels.filter(({ model }) => model.input.includes("image"));
		}

		// Apply search filter (subsequence match: characters must appear in order)
		if (this.searchQuery) {
			const query = this.searchQuery.toLowerCase().replace(/\s+/g, "");
			if (query) {
				filteredModels = filteredModels
					.map((entry) => {
						const searchText = `${entry.provider} ${entry.id} ${entry.model.name}`.toLowerCase();
						return {
							...entry,
							searchScore: subsequenceScore(query, searchText),
						};
					})
					.filter((entry) => (entry.searchScore ?? 0) > 0);
			}
		}

		filteredModels.sort((a, b) => this.compareEntries(a, b));
		return filteredModels;
	}

	private scrollToSelected() {
		requestAnimationFrame(() => {
			const scrollContainer = this.scrollContainerRef.value;
			const selectedElement = scrollContainer?.querySelectorAll("[data-model-item]")[
				this.selectedIndex
			] as HTMLElement;
			if (selectedElement) {
				selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
			}
		});
	}

	protected override renderContent(): TemplateResult {
		const filteredModels = this.getFilteredModels();

		return html`
			<!-- Header and Search -->
			<div class="p-6 pb-4 flex flex-col gap-4 border-b border-border flex-shrink-0">
				${DialogHeader({ title: i18n("Select Model") })}
				${Input({
					placeholder: i18n("Search models..."),
					value: this.searchQuery,
					inputRef: this.searchInputRef,
					onInput: (e: Event) => {
						this.searchQuery = (e.target as HTMLInputElement).value;
						this.selectedIndex = 0;
						// Reset scroll position when search changes
						if (this.scrollContainerRef.value) {
							this.scrollContainerRef.value.scrollTop = 0;
						}
					},
				})}
				<div class="flex gap-2 flex-wrap">
					${Button({
						variant: this.filterThinking ? "default" : "secondary",
						size: "sm",
						onClick: () => {
							this.filterThinking = !this.filterThinking;
							this.selectedIndex = 0;
							if (this.scrollContainerRef.value) {
								this.scrollContainerRef.value.scrollTop = 0;
							}
						},
						className: "rounded-full",
						children: html`<span class="inline-flex items-center gap-1">${icon(Brain, "sm")} ${i18n("Thinking")}</span>`,
					})}
					${Button({
						variant: this.filterVision ? "default" : "secondary",
						size: "sm",
						onClick: () => {
							this.filterVision = !this.filterVision;
							this.selectedIndex = 0;
							if (this.scrollContainerRef.value) {
								this.scrollContainerRef.value.scrollTop = 0;
							}
						},
						className: "rounded-full",
						children: html`<span class="inline-flex items-center gap-1">${icon(ImageIcon, "sm")} ${i18n("Vision")}</span>`,
					})}
				</div>
				<div class="text-xs text-muted-foreground">
					${
						this.favoriteModelKeys.length > 0
							? "Star models to keep your favorites pinned to the top."
							: "Star a model to pin it to the top."
					}
				</div>
			</div>

			<!-- Scrollable model list -->
			<div class="flex-1 overflow-y-auto" ${ref(this.scrollContainerRef)}>
				${filteredModels.map(({ provider, id, model }, index) => {
					const isCurrent = modelsAreEqual(this.currentModel, model);
					const isFavorite = this.isFavorite(model);
					const isSelected = index === this.selectedIndex;
					return html`
						<div
							data-model-item
							class="px-4 py-3 ${
								this.navigationMode === "mouse" ? "hover:bg-muted" : ""
							} cursor-pointer border-b border-border ${isSelected ? "bg-accent" : ""}"
							@click=${() => this.handleSelect(model)}
							@mouseenter=${() => {
								// Only update selection in mouse mode
								if (this.navigationMode === "mouse") {
									this.selectedIndex = index;
								}
							}}
						>
							<div class="flex items-center justify-between gap-2 mb-1">
								<div class="flex items-center gap-2 flex-1 min-w-0">
									<span class="text-sm font-medium text-foreground truncate">${id}</span>
									${isCurrent ? html`<span class="text-green-500">✓</span>` : ""}
								</div>
								<div class="flex items-center gap-2 shrink-0">
									<button
										type="button"
										class="inline-flex items-center justify-center rounded p-1 ${
											isFavorite ? "text-yellow-400" : "text-muted-foreground opacity-60 hover:opacity-100"
										}"
										title=${isFavorite ? "Remove favorite" : "Add favorite"}
										@click=${(e: Event) => {
											e.stopPropagation();
											void this.toggleFavorite(model);
										}}
									>
										${icon(Star, "sm")}
									</button>
									${Badge(provider, "outline")}
								</div>
							</div>
							<div class="flex items-center justify-between text-xs text-muted-foreground gap-2">
								<div class="flex items-center gap-2 min-w-0">
									<span class="${model.reasoning ? "" : "opacity-30"}">${icon(Brain, "sm")}</span>
									<span class="${model.input.includes("image") ? "" : "opacity-30"}">${icon(ImageIcon, "sm")}</span>
									<span>${this.formatTokens(model.contextWindow)}K/${this.formatTokens(model.maxTokens)}K</span>
								</div>
								<span class="shrink-0">${formatModelCost(model.cost)}</span>
							</div>
						</div>
					`;
				})}
			</div>
		`;
	}
}
