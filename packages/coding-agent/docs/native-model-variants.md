# Native model variants

The upstream virtual-model API replaces the fixed `gpt-5.5-fast` catalog patch.
Load the optional example to select the familiar name:

```sh
shuvpi -e ./examples/extensions/priority-model.ts --provider openai --model gpt-5.5-fast
```

The selector keeps **GPT-5.5 Fast**. Requests use the physical `gpt-5.5` model
and `service_tier: "priority"`. Selecting ordinary `gpt-5.5` stops applying that
override. This example uses the virtual-model and request-payload extension APIs;
it does not depend on the `/fast` command.

Provider registrations also belong to their `ModelRuntime`. Replacing or removing
a registered provider in one runtime does not change another runtime's catalog,
credentials, or request handling.
