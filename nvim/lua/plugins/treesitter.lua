return {
  {
    "nvim-treesitter/nvim-treesitter",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      local ts = require("nvim-treesitter")
      ts.setup()

      local parsers = {
        "bash",
        "c",
        "css",
        "dockerfile",
        "go",
        "gomod",
        "gosum",
        "gowork",
        "hcl",
        "html",
        "javascript",
        "json",
        "lua",
        "markdown",
        "markdown_inline",
        "nix",
        "query",
        "terraform",
        "typescript",
        "vim",
        "vimdoc",
        "yaml",
      }

      ts.install(parsers)

      vim.api.nvim_create_autocmd("FileType", {
        group = vim.api.nvim_create_augroup("treesitter_highlight", { clear = true }),
        desc = "Enable treesitter highlighting for buffers",
        callback = function(args)
          pcall(vim.treesitter.start, args.buf)
        end,
      })
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter-textobjects",
    branch = "main",
    dependencies = { "nvim-treesitter/nvim-treesitter" },
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
        vim.keymap.set(mode, "ab", function() select.select_textobject("@block.outer", "textobjects") end, { desc = "around block" })
        vim.keymap.set(mode, "ib", function() select.select_textobject("@block.inner", "textobjects") end, { desc = "inside block" })
        vim.keymap.set(mode, "ai", function() select.select_textobject("@conditional.outer", "textobjects") end, { desc = "around if statement" })
        vim.keymap.set(mode, "ii", function() select.select_textobject("@conditional.inner", "textobjects") end, { desc = "inside if statement" })
      end
    end,
  },
  {
    "nvim-treesitter/nvim-treesitter-context",
    dependencies = { "nvim-treesitter/nvim-treesitter" },
  },
}
