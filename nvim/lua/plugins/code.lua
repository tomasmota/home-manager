return {
  {
    "folke/todo-comments.nvim",
    dependencies = "nvim-lua/plenary.nvim",
    opts = { signs = false }
  },
  {
    "numToStr/Comment.nvim",
    config = function()
      require('Comment').setup {
        pre_hook = require('ts_context_commentstring.integrations.comment_nvim').create_pre_hook(),
      }

      -- comment and duplicate current selection
      vim.keymap.set('x', '<leader>d', function()
        local esc = vim.api.nvim_replace_termcodes(
          '<ESC>', true, false, true
        )
        vim.cmd('normal! y')                                        -- yank selection
        vim.cmd('normal! gv')                                       -- reselect the visual selection
        require('Comment.api').toggle.linewise(vim.fn.visualmode()) -- comment
        vim.api.nvim_feedkeys(esc, 'nx', false)                     -- back to normal mode
        vim.cmd('normal! p')                                        -- paste selection
      end)
    end,
  },
  {
    "windwp/nvim-ts-autotag",
    config = true
  },
  {
    "lukas-reineke/indent-blankline.nvim",
    event = "BufEnter",
    main = "ibl",
    opts = {},
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
  'tpope/vim-sleuth'
}
