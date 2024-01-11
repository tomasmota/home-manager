return {
  {
    "folke/todo-comments.nvim",
    dependencies = "nvim-lua/plenary.nvim",
    config = true
  },
  {
    "numToStr/Comment.nvim",
    config = function()
      require('Comment').setup {
        pre_hook = require('ts_context_commentstring.integrations.comment_nvim').create_pre_hook(),
      }
    end,
  },
  {
    "windwp/nvim-autopairs",
    config = true
  },
  {
    "windwp/nvim-ts-autotag",
    config = true
  }
}
