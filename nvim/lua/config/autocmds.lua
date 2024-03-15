vim.api.nvim_create_autocmd('TextYankPost', {
  group = vim.api.nvim_create_augroup('highlight_yank', {}),
  desc = 'Hightlight selection on yank',
  pattern = '*',
  callback = function()
    vim.highlight.on_yank { higroup = 'IncSearch', timeout = 30 }
  end,
})


vim.api.nvim_create_autocmd('BufWinEnter', {
  group = vim.api.nvim_create_augroup('formatoptions', {}),
  desc = 'Set format options on buffer enter, must be autocmd to override default',
  pattern = '*',
  callback = function()
    vim.opt.formatoptions = vim.opt.formatoptions
        + "c"             -- In general, I like it when comments respect textwidth
        + "q"             -- Allow formatting comments w/ gq
        - "o"             -- O and o, don't continue comments
        + "r"             -- But do continue when pressing enter.
        + "n"             -- Indent past the formatlistpat, not underneath it.
        + "j"             -- Auto-remove comments if possible.
  end,
})
