local opt = vim.opt

-- disable netrw (use oil.nvim as default)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Number of screen lines to keep above and below the cursor
opt.scrolloff = 10

opt.relativenumber = true
opt.number = true

opt.expandtab = true
opt.tabstop = 4
opt.softtabstop = 4
opt.shiftwidth = 4
opt.expandtab = true
opt.autoindent = true

opt.undofile = true
opt.swapfile = false
opt.autoread = true

opt.autoindent = true
opt.smartindent = true
opt.breakindent = true

opt.ignorecase = true --  Ignore case when searching...
opt.smartcase = true  -- ... unless there is a capital letter in the query

opt.belloff = "all"
opt.selection = 'exclusive'

-- set termguicolors to enable highlight groups
opt.termguicolors = true
opt.updatetime = 250
opt.clipboard = "unnamedplus"
opt.signcolumn = "yes"
opt.splitright = true
opt.cmdheight = 0
opt.inccommand = 'split'
