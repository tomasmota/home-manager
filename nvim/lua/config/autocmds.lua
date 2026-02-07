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
  callback = function(args)
    local bufnr = args.buf
    local result = vim.lsp.buf_request_sync(
      bufnr,
      "textDocument/codeAction",
      function(client)
        local params = vim.lsp.util.make_range_params(0, client.offset_encoding)
        params.context = {
          only = { "source.organizeImports" },
          diagnostics = vim.diagnostic.get(bufnr),
        }
        return params
      end,
      1000
    )

    for cid, res in pairs(result or {}) do
      local client = vim.lsp.get_client_by_id(cid)
      for _, action in ipairs(res.result or {}) do
        if action.edit then
          local enc = client and client.offset_encoding or "utf-16"
          vim.lsp.util.apply_workspace_edit(action.edit, enc)
        end

        local command = action.command
        if client and command then
          client:exec_cmd(type(command) == "table" and command or action, { bufnr = bufnr })
        end
      end
    end

    vim.lsp.buf.format({ async = false, bufnr = bufnr })
  end
})
