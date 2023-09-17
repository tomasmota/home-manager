local o = vim.o
local opt = vim.opt

-- set theme
vim.cmd("colorscheme nightfox")

-- disable netrw at the very start of your init.lua (strongly advised)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Number of screen lines to keep above and below the cursor
o.scrolloff = 8

o.relativenumber = true
o.number = true
o.expandtab = true
o.tabstop = 4
o.softtabstop = 4
o.shiftwidth = 4
o.expandtab = true
o.autoindent = true
o.undofile = true
o.swapfile = false

-- set termguicolors to enable highlight groups
opt.termguicolors = true
opt.updatetime = 50
-- Use system clipboard: https://github.com/neovim/neovim/wiki/FAQ#how-to-use-the-windows-clipboard-from-wsl
-- Install win32yank.exe, put this in, and nothing else
opt.clipboard = "unnamedplus"
opt.signcolumn="yes"
opt.splitright=true
opt.cmdheight=0
