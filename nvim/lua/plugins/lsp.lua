return {
  {
    "williamboman/mason.nvim",
    config = true
  },
  {
    "williamboman/mason-lspconfig.nvim",
    opts = {
      -- avaliable lsp servers https://github.com/williamboman/mason-lspconfig.nvim?tab=readme-ov-file#available-lsp-servers
      ensure_installed = {
        "lua_ls",
        "gopls",
        "tsserver",
        "nil_ls",
        "terraformls",
        "yamlls",
        "helm_ls",
        "dockerls"
      }
    }
  },
  {
    "neovim/nvim-lspconfig",
    config = function()
      local lspconfig = require('lspconfig')
      local capabilities = require('cmp_nvim_lsp').default_capabilities()

      -- used to set tabs to 2 spaces in some languages
      local twospaces = function()
        vim.o.tabstop = 2
        vim.o.softtabstop = 2
        vim.o.shiftwidth = 2
        vim.o.expandtab = true
      end

      -- Go
      lspconfig.gopls.setup {
        capabilities = capabilities,
        settings = {
          gopls = {
            experimentalPostfixCompletions = true,
            analyses = {
              unusedparams = true,
              shadow = true,
            },
            staticcheck = true,
          },
        },
        init_options = {
          usePlaceholders = true,
        }
      }

      -- Typescript
      lspconfig.tsserver.setup {
        capabilities = capabilities,
        on_attach = twospaces
      }

      -- Lua
      lspconfig.lua_ls.setup {
        capabilities = capabilities,
        on_attach = twospaces
      }

      -- Yaml
      lspconfig.yamlls.setup {
        settings = {
          yaml = {
            schemaStore = {
              url = "https://www.schemastore.org/api/json/catalog.json",
              enable = true,
            },
            style = {
              flowSequence = 'allow'
            },
            keyOrdering = false
          },
        },
      }

      -- Nix
      lspconfig.nil_ls.setup {
        on_attach = twospaces
      }

      -- Terraform
      lspconfig.terraformls.setup {
        capabilities = capabilities,
        on_attach = twospaces
      }

      -- Terraform
      lspconfig.dockerls.setup {
        capabilities = capabilities,
      }

      vim.keymap.set("n", "K", vim.lsp.buf.hover)
      vim.keymap.set("i", "<C-k>", vim.lsp.buf.signature_help)
      vim.keymap.set("n", "gd", "<cmd>lua vim.lsp.buf.definition()<cr>zz") -- TODO: change this to a function, using vim.api.nvim_win_set_cursor
      vim.keymap.set("n", "gi", vim.lsp.buf.implementation)
      vim.keymap.set("n", "ga", function() vim.lsp.buf.code_action() end)
      vim.keymap.set('n', 'gv', ":vsplit<cr>gd") -- Go to definition in new split


      local telescope = require("telescope.builtin")
      vim.keymap.set("n", "gt", telescope.lsp_type_definitions)
      vim.keymap.set("n", "gr", telescope.lsp_references)
      vim.keymap.set("n", "<leader>r", vim.lsp.buf.rename)
      vim.keymap.set("n", "<leader>e", vim.diagnostic.goto_next)
    end
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
          null_ls.builtins.formatting.hclfmt,   -- hcl
          null_ls.builtins.code_actions.xo,     -- ts and js
          null_ls.builtins.code_actions.statix, -- nix
          null_ls.builtins.code_actions.gitsigns,
          null_ls.builtins.code_actions.templ
        }
      })

      vim.keymap.set('n', '<leader>ff', function()
        vim.lsp.buf.format { async = true }
      end)
    end
  },
  {
    "j-hui/fidget.nvim",
    config = true
  },
  {
    "towolf/vim-helm",
    ft = 'helm',
    config = function()
      local lspconfig = require('lspconfig')
      -- Helm
      lspconfig.helm_ls.setup {
        on_attach = function()
          vim.o.tabstop = 2
          vim.o.softtabstop = 2
          vim.o.shiftwidth = 2
          vim.o.expandtab = true
        end,
        capabilities = require('cmp_nvim_lsp').default_capabilities(),
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
              }
            }
          }
        }
      }
    end
  }
}
