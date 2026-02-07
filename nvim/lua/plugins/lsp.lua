return {
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      { "williamboman/mason.nvim", opts = {} },
      "WhoIsSethDaniel/mason-tool-installer.nvim",
      "williamboman/mason-lspconfig.nvim",
      { "j-hui/fidget.nvim", opts = {} },
    },
    config = function()
      -- used to set tabs to 2 spaces in some languages
      local twospaces = function(_, bufnr)
        bufnr = bufnr or 0
        local opt = vim.bo[bufnr]
        opt.tabstop = 2
        opt.softtabstop = 2
        opt.shiftwidth = 2
        opt.expandtab = true
      end

      local servers = {
        lua_ls = {
          settings = {
            Lua = {
              runtime = { version = 'LuaJIT' },
              workspace = {
                checkThirdParty = false,
                library = {
                  '${3rd}/luv/library',
                  (table.unpack or unpack)(vim.api.nvim_get_runtime_file('', true)),
                },
              },
              completion = {
                callSnippet = 'Replace',
              },
              diagnostics = { disable = { 'missing-fields' } },
            },
          },
          on_attach = twospaces,
        },
        gopls = {
          settings = {
            gopls = {
              -- ["ui.inlayhint.hints"] = {
              --   compositeLiteralFields = true,
              --   constantValues = true,
              --   rangeVariableTypes = true,
              --   assignVariableTypes = true
              -- },
              experimentalPostfixCompletions = true,
              analyses = {
                unusedvariable = true,
                shadow = true,
                useany = true,
              },
              staticcheck = true,
              gofumpt = true,
              semanticTokens = true,
              usePlaceholders = true,
            },
          },
        },
        ts_ls = {
          on_attach = twospaces,
        },
        -- Not able to build this right now, need to investigate
        -- nil_ls = {
        --   on_attach = twospaces,
        -- },
        tofu_ls = {
          on_attach = function(client, bufnr)
            twospaces(client, bufnr)
            vim.keymap.set('n', '<leader>ff', '<cmd>!tofu fmt %<cr><cr>')
          end,
        },
        yamlls = {
          settings = {
            yaml = {
              schemaStore = {
                url = "https://www.schemastore.org/api/json/catalog.json",
                enable = true,
              },
              style = {
                flowSequence = 'allow',
              },
              keyOrdering = false,
            },
          },
        },
        helm_ls = {
          on_attach = twospaces,
          settings = {
            ['helm-ls'] = {
              yamlls = {
                enabled = true,
                diagnosticsLimit = 50,
                showDiagnosticsDirectly = false,
                path = "yaml-language-server",
                config = {
                  schemas = {
                    kubernetes = "**",
                  },
                  completion = true,
                  hover = true,
                },
              },
            },
          },
        },
        dockerls = {},
      }

      -- Adding tools that should be installed by Mason but are not LSP servers
      local ensure_installed = vim.tbl_keys(servers or {})
      vim.list_extend(ensure_installed, {
        -- Formatters
        "stylua",
        "yamlfmt",
        "hclfmt",

        -- Linters
        "hadolint",
      })
      require('mason-tool-installer').setup { ensure_installed = ensure_installed }

      require('mason-lspconfig').setup({
        automatic_enable = false,
      })

      local capabilities = vim.tbl_deep_extend(
        'force',
        vim.lsp.protocol.make_client_capabilities(),
        require('cmp_nvim_lsp').default_capabilities()
      )

      for server_name, server in pairs(servers) do
        server.capabilities = vim.tbl_deep_extend('force', {}, capabilities, server.capabilities or {})
        vim.lsp.config(server_name, server)
      end

      vim.lsp.enable(vim.tbl_keys(servers))

      vim.api.nvim_create_autocmd('LspAttach', {
        group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
        callback = function(event)
          local telescope = require("telescope.builtin")
          vim.keymap.set("n", "gt", telescope.lsp_type_definitions)
          vim.keymap.set("n", "gr", function()
            telescope.lsp_references({
              include_declaration = false,
              trim_text = true,
            })
          end)
          vim.keymap.set("n", "K", vim.lsp.buf.hover)
          vim.keymap.set("i", "<C-k>", vim.lsp.buf.signature_help)
          vim.keymap.set("n", "gd", "<cmd>lua vim.lsp.buf.definition()<cr>zz") -- TODO: change this to a function, using vim.api.nvim_win_set_cursor
          vim.keymap.set('n', 'gs', ":vsplit<cr>gd")                           -- Go to definition in new split
          vim.keymap.set("n", "gi", vim.lsp.buf.implementation)
          vim.keymap.set("n", "ga", vim.lsp.buf.code_action)
          vim.keymap.set("n", "<leader>r", vim.lsp.buf.rename)
          vim.keymap.set("n", "<leader>e", function()
            vim.diagnostic.jump({ count = 1 })
            vim.schedule(function()
              vim.diagnostic.open_float(nil, {
                focusable = false,
                scope = "cursor",
              })
            end)
          end, { desc = "Next diagnostic" })

          local client = vim.lsp.get_client_by_id(event.data.client_id)

          -- Enable inlay hints when available
          if client and client.server_capabilities.inlayHintProvider then
            vim.lsp.inlay_hint.enable(true, { bufnr = event.buf })
          end

          -- Highlight references to symbol under cursor
          if client and client.server_capabilities.documentHighlightProvider then
            vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
              buffer = event.buf,
              callback = vim.lsp.buf.document_highlight,
            })

            vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
              buffer = event.buf,
              callback = vim.lsp.buf.clear_references,
            })
          end
        end,
      })
    end,
  },
  {
    "nvimtools/none-ls.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
      local null_ls = require("null-ls")

      null_ls.setup({
        sources = {
          -- sources: https://github.com/nvimtools/none-ls.nvim/blob/main/doc/BUILTINS.md
          null_ls.builtins.formatting.prettier,
          null_ls.builtins.formatting.hclfmt, -- hcl
          null_ls.builtins.formatting.yamlfmt, -- yaml
          null_ls.builtins.formatting.alejandra, -- nix

          null_ls.builtins.code_actions.statix, -- nix

          null_ls.builtins.diagnostics.hadolint, -- Dockerfiles
          null_ls.builtins.diagnostics.statix, -- nix
        },
      })

      vim.keymap.set('n', '<leader>ff', function()
        vim.lsp.buf.format { async = true }
      end)
    end,
  },
  {
    "towolf/vim-helm",
    ft = 'helm',
  },
}
