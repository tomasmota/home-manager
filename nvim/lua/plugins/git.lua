return {
  {
    'lewis6991/gitsigns.nvim',
    config = true,
    keys = {
      { "<leader>gb", ":Gitsigns toggle_current_line_blame <CR>" }
    }
  },
  {
    'sindrets/diffview.nvim',
    config = true,
    keys = {
      { "<leader>gd", ":DiffviewOpen <CR>" },
      { "<leader>gD", ":DiffviewOpen HEAD~1<CR>" },
      { "<leader>gc", ":DiffviewClose <CR>" },
    }
  }
}
