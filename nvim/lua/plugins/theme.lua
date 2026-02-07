return {
  "catppuccin/nvim",
  name = "catppuccin",
  priority = 1000,
  config = function()
    require("catppuccin").setup({
      auto_integrations = true,
      flavour = "mocha",
    })
    vim.cmd([[colorscheme catppuccin]])
  end,
}
