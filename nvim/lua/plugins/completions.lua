return {
  {
    'hrsh7th/nvim-cmp',
    dependencies = {
      'hrsh7th/cmp-nvim-lsp',
      'hrsh7th/cmp-buffer',
      'hrsh7th/cmp-path',
      'hrsh7th/cmp-cmdline',
      'hrsh7th/nvim-cmp',
      'onsails/lspkind.nvim',
      'windwp/nvim-autopairs'
    },
    config = function()
      local cmp = require 'cmp'

      -- Integrate nvim-autopairs with cmp
      local cmp_autopairs = require("nvim-autopairs.completion.cmp")
      require("nvim-autopairs").setup()
			cmp.event:on("confirm_done", cmp_autopairs.on_confirm_done())

      cmp.setup({
        snippet = {
          expand = function(args)
            require('luasnip').lsp_expand(args.body)
          end
        },
        window = {
          completion = cmp.config.window.bordered(),
          documentation = cmp.config.window.bordered(),
        },
        mapping = cmp.mapping.preset.insert({
          ['<C-b>'] = cmp.mapping.scroll_docs(-4),
          ['<C-f>'] = cmp.mapping.scroll_docs(4),
          ['<C-Space>'] = cmp.mapping.complete(),
          ['<C-e>'] = cmp.mapping.abort(),
          ['<CR>'] = cmp.mapping.confirm({ select = true }),
        }),
        completion = { completeopt = "menu,menuone,noinsert" },
        experimental = { ghost_text = true },
        sources = cmp.config.sources({
          { name = 'nvim_lsp' },
          { name = 'luasnip', max_item_count = 3 },
          { name = 'path', max_item_count = 3 },
          { name = 'buffer', max_item_count = 5 },
        }),
        formatting = {
          expandable_indicator = true,
          format = require("lspkind").cmp_format({
            mode = "symbol_text",
            maxwidth = 50,
            ellipsis_char = "...",
            symbol_map = {
              Copilot = "",
            },
          }),
        },
      })
    end
  },
  {
    "L3MON4D3/LuaSnip",
    version = "v2.*",
    dependencies = {
      'saadparwaiz1/cmp_luasnip',
      'rafamadriz/friendly-snippets'
    },
    config = function()
      local ls = require("luasnip")
      vim.keymap.set({ "i", "s" }, "<C-l>", function() ls.jump(1) end, { silent = true })
      vim.keymap.set({ "i", "s" }, "<C-h>", function() ls.jump(-1) end, { silent = true })
      require("luasnip.loaders.from_vscode").lazy_load()
    end
  }
}
