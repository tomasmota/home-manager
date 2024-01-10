return {
  "catppuccin/nvim",
  lazy = false, 
  priority = 1000,
  config = function()
    vim.cmd([[colorscheme catppuccin-mocha]])
    require("catppuccin").setup({
      integrations = {
        cmp = true,
        gitsigns = true,
        treesitter = true,
      },
    })
  end
}
