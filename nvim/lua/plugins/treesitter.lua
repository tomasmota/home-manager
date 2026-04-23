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
  {
    "JoosepAlviste/nvim-ts-context-commentstring",
    init = function()
      vim.g.skip_ts_context_commentstring_module = true
    end,
    opts = { enable_autocmd = false },
    config = function(_, opts)
      require("ts_context_commentstring").setup(opts)
      local get_option = vim.filetype.get_option
      vim.filetype.get_option = function(filetype, option)
        return option == "commentstring"
          and require("ts_context_commentstring.internal").calculate_commentstring()
          or get_option(filetype, option)
      end
    end,
  },
  "nvim-treesitter/nvim-treesitter-context",
}
