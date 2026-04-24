# Neovim Config TODO

Outdated patterns and simplification opportunities (reviewed 2026-04-23, nvim 0.12.1).

## High Priority

- [x] **Replace `nvim-cmp` with `blink.cmp`** — dropped nvim-cmp, cmp-nvim-lsp, cmp-buffer, cmp-path, cmp-cmdline, cmp_luasnip, LuaSnip, lspkind.nvim. blink.cmp handles completions, snippets, and fuzzy matching in one plugin.
- [ ] **Replace `none-ls.nvim` with `conform.nvim` + `nvim-lint`** — none-ls is in maintenance mode. Using it for formatting (prettier, hclfmt, yamlfmt, alejandra) and diagnostics (hadolint, statix).
- [x] **Remove `nvim-ts-context-commentstring`** — removed plugin and `vim.filetype.get_option` override hack; relying on native commentstring support in nvim 0.12.
- [x] **Remove `Comment.nvim`** — already absent from config and lockfile; built-in `gc`/`gcc` covers comments.

## Low Priority / Cleanup

- [x] **Fix broken keymap** — `"<C-r>"` mapping now reloads current file.
- [x] **Remove duplicate settings** — dropped repeated `expandtab` and `autoindent` assignments from `settings.lua`.
- [x] **Remove duplicate `mapleader`** — keeping only `init.lua`.
- [x] **Remove `termguicolors` setting** — relying on nvim default in Ghostty.
- [x] **Remove netrw disable** — oil.nvim already disables netrw when acting as default file explorer.
- [ ] **Revisit `harpoon` branch specifier** — remote default is `master`, so keep `harpoon2` while config uses harpoon2 API.
- [x] **Remove redundant `opts = {}` from indent-blankline** — `config` handles setup.
