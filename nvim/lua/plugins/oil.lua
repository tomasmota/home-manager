return {
  {
    "stevearc/oil.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    config = function()
      local oil = require("oil")
      oil.setup({
        -- This is needed for git-status inside Oil
        win_options = {
          signcolumn = "yes:2",
        },
      })
      vim.keymap.set('n', '<leader>o', oil.toggle_float)
    end,
  },
  {
    "refractalize/oil-git-status.nvim",
    dependencies = {
      "stevearc/oil.nvim",
    },
    config = true,
  },
}
