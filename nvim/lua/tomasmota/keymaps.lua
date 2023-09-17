-- Set leader to space
vim.g.mapleader = ' '

-- Save with <leader>
vim.keymap.set('n', '<leader>s', ':w<CR>')
-- Quit with <leader>
vim.keymap.set('n', '<leader>q', ':q<CR>')
-- Clear highlighted search
vim.keymap.set('n', '<C-l>', ':nohlsearch<CR>')

vim.keymap.set('n', '<C-u>', '<C-u>zz')
vim.keymap.set('n', '<C-d>', '<C-d>zz')
vim.keymap.set("n", "n", "nzzzv")
vim.keymap.set("n", "N", "Nzzzv")

-- Mimic shell movements
vim.keymap.set('i', '<C-E>', '<ESC>A')
vim.keymap.set('i', '<C-A>', '<ESC>I')

vim.keymap.set("n", "C-r", ":luafile %<CR>")

-- If I visually select words and paste from clipboard, don't replace existing clip
vim.keymap.set("x", "p", "\"_dP")

-- Stay in visual mode when changing the indent for the selection
vim.keymap.set("v", ">", ">gv")
vim.keymap.set("v", "<", "<gv")

-- Go to definition in new split
vim.keymap.set('n', 'gv', ":vsplit<cr>gd")

-- Go to definition in new split
vim.keymap.set('n', '<C-n>', ":bnext<cr>")

-- TELESCOPE
local builtin = require('telescope.builtin')
vim.keymap.set('n', '<leader>p', builtin.find_files)
-- vim.keymap.set('n', '<leader>fa', builtin.live_grep) -- grep across all files in current directory
vim.keymap.set('n', '<leader>fk', builtin.keymaps)
vim.keymap.set('n', '<leader>fs', builtin.lsp_document_symbols)
vim.keymap.set('n', '<leader>fa', require('telescope').extensions.live_grep_args.live_grep_args)
vim.keymap.set('n', '<leader>fr', require('telescope').extensions.repo.repo)
vim.keymap.set('n', '<leader>fb', require('telescope').extensions.file_browser.file_browser)
vim.keymap.set("n", "<leader>le", "<cmd>Telescope diagnostics<cr>")
vim.keymap.set('n', '<leader>h', builtin.help_tags) -- grep help docs
vim.keymap.set('n', '<leader>gst', builtin.git_status)
vim.keymap.set('n', '<leader>b', builtin.buffers)
vim.keymap.set('n', '<c-f>', builtin.current_buffer_fuzzy_find)

-- SNIPS
local ls = require("luasnip")
vim.keymap.set({ "i", "s" }, "<c-n>", ls.expand_or_jump)
vim.keymap.set({ "i", "s" }, "<c-p>", function() ls.jump(-1) end)

-- GIT
local gs = require("gitsigns")
vim.keymap.set('n', '<leader>gd', ":DiffviewOpen <CR>")
vim.keymap.set('n', '<leader>gD', ":DiffviewOpen HEAD~1<CR>")
vim.keymap.set('n', '<leader>gc', ":DiffviewClose <CR>")
vim.keymap.set('n', '<leader>gb', function () gs.toggle_current_line_blame() end)

-- CHEZMOI
vim.keymap.set('n', '<leader>cma', ":! chezmoi apply<CR><CR>")

-- quickfix list
vim.keymap.set('n', '<leader>qn', ":cnext<cr>")
vim.keymap.set('n', '<leader>qp', ":cprev<cr>")
