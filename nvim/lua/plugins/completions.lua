return {
  {
    'hrsh7th/nvim-cmp',
    event = 'InsertEnter',
    dependencies = {
      -- completion integrations
      'hrsh7th/cmp-nvim-lsp',
      'hrsh7th/cmp-buffer',
      'hrsh7th/cmp-path',
      'hrsh7th/cmp-cmdline',

      -- icons
      'onsails/lspkind.nvim',

      -- autopairs
      -- 'windwp/nvim-autopairs'

      -- luasnip
      'L3MON4D3/LuaSnip',
      'saadparwaiz1/cmp_luasnip',
      'rafamadriz/friendly-snippets'
    },
    config = function()
      local cmp = require 'cmp'
      local luasnip = require 'luasnip'
      require('luasnip.loaders.from_vscode').lazy_load()
      luasnip.config.setup {}

      -- Integrate nvim-autopairs with cmp (trying out not using this for now)
      --
      -- local cmp_autopairs = require("nvim-autopairs.completion.cmp")
      -- require("nvim-autopairs").setup()
      -- cmp.event:on("confirm_done", cmp_autopairs.on_confirm_done())

      cmp.setup({
        snippet = {
          expand = function(args)
            luasnip.lsp_expand(args.body)
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
          ['<C-o>'] = cmp.mapping.confirm({ select = true }),
          ['<C-l>'] = cmp.mapping(function()
            if luasnip.expand_or_locally_jumpable() then
              luasnip.expand_or_jump()
            end
          end, { 'i', 's' }),
          ['<C-h>'] = cmp.mapping(function()
            if luasnip.locally_jumpable(-1) then
              luasnip.jump(-1)
            end
          end, { 'i', 's' }),
        }),
        completion = { completeopt = "menu,menuone,noinsert" },
        experimental = { ghost_text = true },
        sources = cmp.config.sources({
          { name = 'nvim_lsp' },
          { name = 'copilot' },
          { name = 'luasnip', max_item_count = 3 },
          { name = 'path',    max_item_count = 3 },
          { name = 'buffer',  max_item_count = 5 },
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
  }
}
