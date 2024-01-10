return {
  'nvim-telescope/telescope.nvim', branch = '0.1.x',
  dependencies = { 
    'nvim-lua/plenary.nvim',
    'nvim-telescope/telescope-live-grep-args.nvim',
    'nvim-telescope/telescope-ui-select.nvim',
    'nvim-telescope/telescope-file-browser.nvim',
  },
  config = function()
    local telescope = require('telescope')
    local lga_actions = require("telescope-live-grep-args.actions")
    telescope.setup({
        winblend = 10,
        defaults = {
            mappings = {
                i = {
                    ['<C-\\>'] = 'select_vertical',
                },
                n = {
                    ['<C-\\>'] = 'select_vertical',
                }
            }
        },
        pickers = {
            -- find_files = {
            --     theme = "ivy",
            --     layout_config = { height = 0.7 },
            -- },
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
                        ["<C-k>"] = lga_actions.quote_prompt({ postfix = " -t " }), -- TODO: fix this
                    },
                },
            },
            ["ui-select"] = {
                require("telescope.themes").get_dropdown({
                    previewer        = false,
                    initial_mode     = "normal",
                    sorting_strategy = 'ascending',
                    layout_strategy  = 'horizontal',
                    layout_config    = {
                        horizontal = {
                            width = 0.5,
                            height = 0.4,
                            preview_width = 0.6,
                        },
                    },
                })
            },
        }
    })

    telescope.load_extension('file_browser')
    telescope.load_extension('live_grep_args')
    telescope.load_extension('ui-select')
  end
}
