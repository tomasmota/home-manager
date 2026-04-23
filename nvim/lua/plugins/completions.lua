local terraform_filetypes = {
  terraform = true,
  ['terraform-vars'] = true,
  opentofu = true,
  ['opentofu-vars'] = true,
  hcl = true,
}

return {
  {
    'saghen/blink.cmp',
    version = '1.*',
    dependencies = {
      'rafamadriz/friendly-snippets',
    },
    ---@module 'blink.cmp'
    ---@type blink.cmp.Config
    opts = {
      appearance = {
        nerd_font_variant = 'mono',
      },
      keymap = {
        preset = 'default',
        ['<C-o>'] = { 'accept', 'fallback' },
        ['<C-l>'] = { 'snippet_forward', 'fallback' },
        ['<C-h>'] = { 'snippet_backward', 'fallback' },
      },
      completion = {
        list = {
          max_items = 30,
          selection = {
            preselect = false,
            auto_insert = false,
          },
        },
        menu = {
          border = 'rounded',
          auto_show_delay_ms = 100,
          draw = {
            columns = {
              { 'kind_icon' },
              { 'label', 'label_description', gap = 1 },
              { 'source_name' },
            },
            components = {
              label = {
                width = { fill = true, max = 60 },
              },
              label_description = {
                width = { max = 24 },
              },
              source_name = {
                width = { max = 6 },
              },
            },
          },
        },
        documentation = {
          auto_show = true,
          auto_show_delay_ms = 200,
          window = {
            border = 'rounded',
          },
        },
        ghost_text = { enabled = false },
      },
      fuzzy = {
        implementation = 'prefer_rust',
        sorts = { 'exact', 'score', 'sort_text' },
      },
      sources = {
        default = { 'lsp', 'path', 'snippets', 'buffer' },
        providers = {
          lsp = {
            name = 'LSP',
          },
          path = {
            name = 'Path',
          },
          snippets = {
            name = 'Snip',
            min_keyword_length = 2,
            opts = {
              filter_snippets = function(filetype, file)
                return not (
                  terraform_filetypes[filetype]
                  and file:match('friendly.snippets')
                  and file:match('terraform%.json$')
                )
              end,
            },
          },
          buffer = {
            name = 'Buf',
            min_keyword_length = 4,
          },
        },
      },
    },
  },
  {
    'windwp/nvim-autopairs',
    event = 'InsertEnter',
    opts = {},
  },
}
