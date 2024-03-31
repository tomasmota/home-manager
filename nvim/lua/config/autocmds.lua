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

-- taken from https://github.com/golang/tools/blob/master/gopls/doc/vim.md#imports-and-formatting
vim.api.nvim_create_autocmd('BufWritePre', {
  group = vim.api.nvim_create_augroup('go_imports_format_onsave', {}),
  desc = 'Autoformat and organize imports when saving go files',
  pattern = "*.go",
  callback = function()
    local params = vim.lsp.util.make_range_params()
    params.context = {only = {"source.organizeImports"}}
    local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params)
    for cid, res in pairs(result or {}) do
      for _, r in pairs(res.result or {}) do
        if r.edit then
          local enc = (vim.lsp.get_client_by_id(cid) or {}).offset_encoding or "utf-16"
          vim.lsp.util.apply_workspace_edit(r.edit, enc)
        end
      end
    end
    vim.lsp.buf.format({async = false})
  end
})
