local opt = vim.opt

-- disable netrw (use oil.nvim as default)
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Number of screen lines to keep above and below the cursor
opt.scrolloff = 8

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
opt.belloff = "all"
opt.selection = 'exclusive'
opt.autoindent = true
opt.smartindent = true
opt.ignorecase = true -- Ignore case when searching...
opt.smartcase = true -- ... unless there is a capital letter in the query
opt.formatoptions = opt.formatoptions
  - "a" -- Auto formatting is BAD.
  - "t" -- Don't auto format my code. I got linters for that.
  + "c" -- In general, I like it when comments respect textwidth
  + "q" -- Allow formatting comments w/ gq
  - "o" -- O and o, don't continue comments
  + "r" -- But do continue when pressing enter.
  + "n" -- Indent past the formatlistpat, not underneath it.
  + "j" -- Auto-remove comments if possible.
  - "2" -- I'm not in gradeschool anymore

-- set termguicolors to enable highlight groups
opt.termguicolors = true
opt.updatetime = 50
-- Use system clipboard: https://github.com/neovim/neovim/wiki/FAQ#how-to-use-the-windows-clipboard-from-wsl
-- Install win32yank.exe, put this in, and nothing else
opt.clipboard = "unnamedplus"
opt.signcolumn="yes"
opt.splitright=true
opt.cmdheight=0
