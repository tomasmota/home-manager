return {
  {
    "zbirenbaum/copilot.lua",
    event = { "BufEnter" },
    config = function()
      require("copilot").setup({
        suggestion = {
          enabled = false,
        },
        panel = { enabled = false },
      })
    end,
  },
  {
    "zbirenbaum/copilot-cmp",
    event = { "BufEnter" },
    enabled = false,
    dependencies = { "zbirenbaum/copilot.lua" },
    config = function()
      require("copilot_cmp").setup()
    end,
  },
}
