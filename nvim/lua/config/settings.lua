local opt = vim.opt

-- Number of screen lines to keep above and below the cursor
opt.scrolloff = 10

opt.relativenumber = true
opt.number = true

opt.expandtab = true
opt.tabstop = 4
opt.softtabstop = 4
opt.shiftwidth = 4

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

opt.updatetime = 250
opt.clipboard = "unnamedplus"
opt.signcolumn = "yes"
opt.splitright = true
opt.cmdheight = 0
opt.inccommand = 'split'
