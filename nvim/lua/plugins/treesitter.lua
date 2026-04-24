return {
  {
    "nvim-treesitter/nvim-treesitter-textobjects",
    branch = "main",
    config = function()
      require("nvim-treesitter-textobjects").setup({
        select = {
          lookahead = true,
          include_surrounding_whitespace = false,
        },
      })

      local select = require("nvim-treesitter-textobjects.select")
      for _, mode in ipairs({ "x", "o" }) do
        vim.keymap.set(mode, "af", function() select.select_textobject("@function.outer", "textobjects") end, { desc = "around function" })
        vim.keymap.set(mode, "if", function() select.select_textobject("@function.inner", "textobjects") end, { desc = "inside function" })
        vim.keymap.set(mode, "ab", function() select.select_textobject("@block.inner", "textobjects") end, { desc = "around block" })
        vim.keymap.set(mode, "ib", function() select.select_textobject("@block.inner", "textobjects") end, { desc = "inside block" })
        vim.keymap.set(mode, "ai", function() select.select_textobject("@conditional.outer", "textobjects") end, { desc = "around if statement" })
        vim.keymap.set(mode, "ii", function() select.select_textobject("@conditional.inner", "textobjects") end, { desc = "inside if statement" })
      end
    end,
  },
  "nvim-treesitter/nvim-treesitter-context",
}
