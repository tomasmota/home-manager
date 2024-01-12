vim.api.nvim_create_autocmd('TextYankPost', {
  group = vim.api.nvim_create_augroup('highlight_yank', {}),
  desc = 'Hightlight selection on yank',
  pattern = '*',
  callback = function()
    vim.highlight.on_yank { higroup = 'IncSearch', timeout = 30 }
  end,
})

-- -- Open Telescope find_files when opening nvim with a directory as first argument
-- _G.open_telescope = function()
--     local first_arg = vim.v.argv[#vim.v.argv]
--     if first_arg and vim.fn.isdirectory(first_arg) == 1 then
--         vim.g.loaded_netrw = true
--         require("telescope.builtin").find_files({search_dirs = {first_arg}})
--     end
-- end
-- vim.api.nvim_exec([[
-- augroup TelescopeOnEnter
--     autocmd!
--     autocmd VimEnter * lua open_telescope()
-- augroup END
-- ]], false)
