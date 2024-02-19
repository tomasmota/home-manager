-- Set leader to space
vim.g.mapleader = ' '

-- Save with <leader>
vim.keymap.set('n', '<leader>s', ':w<CR>')
-- Quit with <leader>
vim.keymap.set('n', '<leader>q', ':q<CR>')
-- Clear highlighted search
vim.keymap.set('n', '<C-l>', ':nohlsearch<CR>')

-- Navigation
vim.keymap.set('n', '<C-u>', '<C-u>zz')
vim.keymap.set('n', '<C-d>', '<C-d>zz')
vim.keymap.set("n", "n", "nzzzv")
vim.keymap.set("n", "N", "Nzzzv")
vim.keymap.set("n", "<C-j>", "<C-e>")
vim.keymap.set("n", "<C-k>", "<C-y>")

-- Mimic shell movements
vim.keymap.set('i', '<C-E>', '<ESC>A')
vim.keymap.set('i', '<C-A>', '<ESC>I')

vim.keymap.set("n", "C-r", ":luafile %<CR>")

-- If I visually select words and paste from clipboard, don't replace existing clip
vim.keymap.set("x", "p", "\"_dP")

-- Stay in visual mode when changing the indent for the selection
vim.keymap.set("v", ">", ">gv")
vim.keymap.set("v", "<", "<gv")

-- quickfix list
vim.keymap.set('n', '<leader>cn', ":cnext<cr>")
vim.keymap.set('n', '<leader>cp', ":cprev<cr>")
vim.keymap.set('n', '<leader>cc', ":cclose<cr>")
