return {
  'nvim-telescope/telescope.nvim',
  event = 'VeryLazy',
  branch = '0.1.x',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-telescope/telescope-live-grep-args.nvim',
    'nvim-telescope/telescope-ui-select.nvim',
    'nvim-telescope/telescope-frecency.nvim',
  },
  config = function()
    local telescope = require('telescope')
    local lga_actions = require("telescope-live-grep-args.actions")
    telescope.setup({
      winblend = 10,
      defaults = {
        path_display = {
          shorten = 20
        }
      },
      pickers = {
        lsp_document_symbols = {
          symbol_width = 70,
        }
      },
      layout_config = {
        height = 0.9,
        width = 0.9,
      },
      extensions = {
        live_grep_args = {
          auto_quoting = true,
          mappings = {
            i = {
              ["<C-k>"] = lga_actions.quote_prompt({ postfix = " -t " }),
            },
          },
        },
        ["ui-select"] = {
          require("telescope.themes").get_dropdown {}
        },
      }
    })

    telescope.load_extension('live_grep_args')
    telescope.load_extension('ui-select')
    telescope.load_extension('frecency') --TODO: try this out

    -- keymaps
    local builtin = require('telescope.builtin')
    vim.keymap.set('n', '<leader>p', builtin.find_files)
    vim.keymap.set('n', '<leader>a', function() builtin.find_files({ hidden = true, no_ignore = true }) end)
    vim.keymap.set('n', '<leader>k', builtin.keymaps)
    vim.keymap.set('n', '<leader>fs', builtin.lsp_document_symbols)
    vim.keymap.set('n', '<leader>b', builtin.buffers)
    vim.keymap.set('n', '<leader>fa', require('telescope').extensions.live_grep_args.live_grep_args)
    vim.keymap.set("n", "<leader>le", builtin.diagnostics)
    vim.keymap.set('n', '<leader>fh', builtin.help_tags) -- grep help docs
    vim.keymap.set('n', '<leader>gst', builtin.git_status)
    vim.keymap.set('n', '<c-f>', builtin.current_buffer_fuzzy_find)
  end
}
