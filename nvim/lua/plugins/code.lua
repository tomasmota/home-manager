return {
  {
    "folke/todo-comments.nvim",
    dependencies = "nvim-lua/plenary.nvim",
    opts = { signs = false }
  },
  {
    "lukas-reineke/indent-blankline.nvim",
    event = "BufEnter",
    main = "ibl",
    config = function()
      require("ibl").setup({
        scope = {
          enabled = false,
          show_start = false,
          show_end = false,
        },
      })
    end,
  },
}
