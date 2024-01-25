return {
  "ThePrimeagen/harpoon",
  branch = "harpoon2",
  opts = {},
  config = function()
    local harpoon = require('harpoon')
    harpoon:setup()

    vim.keymap.set("n", "<M-a>", function() harpoon:list():append() end)
    vim.keymap.set("n", "<M-e>", function() harpoon.ui:toggle_quick_menu(harpoon:list()) end)

    vim.keymap.set("n", "<M-h>", function() harpoon:list():select(1) end)
    vim.keymap.set("n", "<M-j>", function() harpoon:list():select(2) end)
    vim.keymap.set("n", "<M-k>", function() harpoon:list():select(3) end)
    vim.keymap.set("n", "<M-l>", function() harpoon:list():select(4) end)
  end,
}
