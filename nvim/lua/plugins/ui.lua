return {
  {
    'nvim-lualine/lualine.nvim',
    dependencies = { 'nvim-tree/nvim-web-devicons', opt = true },
    config = function()
      require('lualine').setup({
        sections = {
          lualine_c = {
            {
              'filename',
              path = 1 -- 0 = just filename, 1 = relative path, 2 = absolute path
            },
          }
        }
      })
    end
  },
  {
    "folke/noice.nvim",
    event = "VeryLazy",
    enabled = false,
    opts = {
      messages = {
        enabled = false,
      }
    },
    dependencies = {
      "MunifTanjim/nui.nvim",
      "rcarriga/nvim-notify",
    }
  }
}
