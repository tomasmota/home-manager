return {
  "stevearc/oil.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  config = function ()
    local oil = require("oil")
    oil.setup({
      default_file_explorer = false,
    })
    vim.keymap.set('n', '<leader>o', oil.toggle_float)
  end,
}
