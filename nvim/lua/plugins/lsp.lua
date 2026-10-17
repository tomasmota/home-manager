return {
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      { "williamboman/mason.nvim", opts = {} },
      "WhoIsSethDaniel/mason-tool-installer.nvim",
      "mason-org/mason-lspconfig.nvim",
      { "j-hui/fidget.nvim", opts = {} },
      "saghen/blink.cmp",
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
          cmd = { 'tofu-ls', 'serve', '-log-file=/dev/null' }, -- stderr otherwise floods lsp.log at ERROR
          root_dir = function(bufnr, on_dir)
            local root = vim.fs.root(bufnr, { '.terraform', '.git' })
            if root then
              on_dir(root)
            end
          end,
          on_attach = function(client, bufnr)
            -- Work around a tofu-ls semantic-token bug; remove this once tofu-ls fixes heredoc interpolation ranges.
            client.server_capabilities.semanticTokensProvider = nil
            twospaces(client, bufnr)
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
      require('mason-tool-installer').setup {
        ensure_installed = ensure_installed,
        -- Avoid a periodic Mason registry refresh while opening Neovim.
        run_on_start = false,
      }

      require('mason-lspconfig').setup({
        automatic_enable = false,
      })

      local capabilities = require('blink.cmp').get_lsp_capabilities()

      local function is_file_buffer(bufnr)
        local scheme = vim.api.nvim_buf_get_name(bufnr):match('^(%a[%w+.-]*)://')
        return not scheme or scheme == 'file'
      end

      for server_name, server in pairs(servers) do
        server.capabilities = vim.tbl_deep_extend('force', {}, capabilities, server.capabilities or {})
        vim.lsp.config(server_name, server)

        -- Central guard: only start servers for file buffers, not diffview://, oil://, ... URIs.
        -- This must run before start, since didOpen is sent before LspAttach and crashes helm_ls.
        -- on_dir(nil) still lets vim.lsp.start resolve root_markers/workspace_required itself.
        local base_root_dir = vim.lsp.config[server_name].root_dir
        vim.lsp.config(server_name, {
          root_dir = function(bufnr, on_dir)
            if not is_file_buffer(bufnr) then
              return
            end
            if type(base_root_dir) == 'function' then
              base_root_dir(bufnr, on_dir)
            else
              on_dir(base_root_dir)
            end
          end,
        })
      end

      vim.lsp.enable(vim.tbl_keys(servers))

      vim.api.nvim_create_autocmd({ 'LspAttach', 'BufFilePost' }, {
        group = vim.api.nvim_create_augroup('lsp-file-buffers', { clear = true }),
        callback = function(event)
          if is_file_buffer(event.buf) then
            return
          end
          -- LspAttach runs before the client finishes recording its attached buffer.
          vim.schedule(function()
            if not vim.api.nvim_buf_is_valid(event.buf) or is_file_buffer(event.buf) then
              return
            end
            for _, client in ipairs(vim.lsp.get_clients({ bufnr = event.buf })) do
              vim.lsp.buf_detach_client(event.buf, client.id)
            end
          end)
        end,
      })

      vim.api.nvim_create_autocmd('LspAttach', {
        group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
        callback = function(event)
          if not is_file_buffer(event.buf) then
            return
          end
          local client = vim.lsp.get_client_by_id(event.data.client_id)
          local bufnr = event.buf

          local telescope = require("telescope.builtin")
          local function map(mode, lhs, rhs, desc, opts)
            vim.keymap.set(mode, lhs, rhs, vim.tbl_extend('force', { buffer = bufnr, desc = desc }, opts or {}))
          end

          map("n", "gt", telescope.lsp_type_definitions, "Go to type definition")
          -- nowait: the 0.12 default gr* maps (grn, grr, ...) would otherwise delay gr by 'timeoutlen'.
          map("n", "gr", function()
            telescope.lsp_references({
              include_declaration = false,
              trim_text = true,
            })
          end, "References", { nowait = true })
          map("n", "K", vim.lsp.buf.hover, "Hover")
          map("i", "<C-k>", vim.lsp.buf.signature_help, "Signature help")
          map("n", "gd", "<cmd>lua vim.lsp.buf.definition()<cr>zz", "Go to definition") -- TODO: change this to a function, using vim.api.nvim_win_set_cursor
          map("n", "gs", ":vsplit<cr>gd", "Go to definition in split")
          map("n", "gi", vim.lsp.buf.implementation, "Go to implementation")
          map("n", "ga", vim.lsp.buf.code_action, "Code action")
          map("n", "<leader>r", vim.lsp.buf.rename, "Rename symbol")
          map("n", "<leader>e", function()
            vim.diagnostic.jump({ count = 1 })
            vim.schedule(function()
              vim.diagnostic.open_float(nil, {
                focusable = false,
                scope = "cursor",
              })
            end)
          end, "Next diagnostic")

          -- Enable inlay hints when available
          if client and client.server_capabilities.inlayHintProvider then
            vim.lsp.inlay_hint.enable(true, { bufnr = bufnr })
          end

          -- Highlight references to symbol under cursor. One group per buffer, cleared on each
          -- attach, so several clients or re-attaches never stack autocmds.
          if client and client:supports_method('textDocument/documentHighlight', bufnr) then
            local group = vim.api.nvim_create_augroup('lsp-highlight-' .. bufnr, { clear = true })
            vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
              group = group,
              buffer = bufnr,
              callback = vim.lsp.buf.document_highlight,
            })

            vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
              group = group,
              buffer = bufnr,
              callback = vim.lsp.buf.clear_references,
            })
          end
        end,
      })

      vim.api.nvim_create_autocmd('LspDetach', {
        group = vim.api.nvim_create_augroup('lsp-detach', { clear = true }),
        callback = function(event)
          -- Drop highlight autocmds once no remaining client on the buffer can highlight.
          for _, other in ipairs(vim.lsp.get_clients({ bufnr = event.buf })) do
            if other.id ~= event.data.client_id and other:supports_method('textDocument/documentHighlight', event.buf) then
              return
            end
          end
          pcall(vim.api.nvim_del_augroup_by_name, 'lsp-highlight-' .. event.buf)
          if vim.api.nvim_buf_is_valid(event.buf) then
            vim.api.nvim_buf_call(event.buf, vim.lsp.buf.clear_references)
          end
        end,
      })
    end,
  },
  {
    "stevearc/conform.nvim",
    cmd = "ConformInfo",
    keys = {
      {
        "<leader>ff",
        function()
          require("conform").format({ async = true, lsp_format = "fallback" })
        end,
        mode = { "n", "v" },
        desc = "Format buffer",
      },
    },
    opts = {
      formatters_by_ft = {
        lua = { "stylua" },
        go = { "goimports" },
        javascript = { "prettier" },
        javascriptreact = { "prettier" },
        typescript = { "prettier" },
        typescriptreact = { "prettier" },
        vue = { "prettier" },
        css = { "prettier" },
        scss = { "prettier" },
        less = { "prettier" },
        html = { "prettier" },
        json = { "prettier" },
        jsonc = { "prettier" },
        markdown = { "prettier" },
        graphql = { "prettier" },
        yaml = { "yamlfmt" },
        nix = { "alejandra" },
        hcl = { "hcl" },
        terraform = { "tofu_fmt" },
        ["terraform-vars"] = { "tofu_fmt" },
        opentofu = { "tofu_fmt" },
        ["opentofu-vars"] = { "tofu_fmt" },
      },
      default_format_opts = {
        lsp_format = "fallback",
      },
      notify_no_formatters = false,
    },
  },
  {
    "mfussenegger/nvim-lint",
    event = { "BufReadPost", "BufWritePost" },
    config = function()
      local lint = require("lint")

      lint.linters_by_ft = {
        dockerfile = { "hadolint" },
        nix = { "statix" },
      }

      vim.api.nvim_create_autocmd({ "BufReadPost", "BufWritePost" }, {
        group = vim.api.nvim_create_augroup("nvim_lint", { clear = true }),
        callback = function()
          lint.try_lint()
        end,
      })

      vim.schedule(function()
        lint.try_lint()
      end)
    end,
  },
  {
    "towolf/vim-helm",
    ft = 'helm',
  },
}
