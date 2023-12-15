-- Packer Bootstrap
local ensure_packer = function()
  local fn = vim.fn
  local install_path = fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
  if fn.empty(fn.glob(install_path)) > 0 then
    fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
    vim.cmd [[packadd packer.nvim]]
    return true
  end
  return false
end

local packer_bootstrap = ensure_packer()

return require('packer').startup(function(use)
    use 'wbthomason/packer.nvim'

    use {
        'nvim-treesitter/nvim-treesitter',
        requires = {
            { 'nvim-treesitter/nvim-treesitter-textobjects' },
            { 'nvim-treesitter/nvim-treesitter-context' },
            { 'nvim-treesitter/playground' },
            { 'JoosepAlviste/nvim-ts-context-commentstring' }
        },
        run = ':TSUpdate'
    }

    -- Themes
    use 'EdenEast/nightfox.nvim'

    -- Telescope
    -- requires https://github.com/BurntSushi/ripgrep
    -- requires https://github.com/sharkdp/fd (sudo apt install fd-find)
    use {
        'nvim-telescope/telescope.nvim', branch = '0.1.x',
        requires = {
            {'nvim-lua/plenary.nvim'},
            { 'nvim-telescope/telescope-live-grep-args.nvim' },
            { 'nvim-telescope/telescope-ui-select.nvim' },
            { 'nvim-telescope/telescope-file-browser.nvim' },
            { 'cljoly/telescope-repo.nvim'},
            {'nvim-telescope/telescope-fzf-native.nvim', run = 'make' },
        }
    }

    -- Comments
    use {
        'numToStr/Comment.nvim',
        config = function()
            require('Comment').setup{
                pre_hook = require('ts_context_commentstring.integrations.comment_nvim').create_pre_hook(),
            }
        end
    }

    use {
        'folke/todo-comments.nvim',
        requires = "nvim-lua/plenary.nvim",
        config = function()
            require("todo-comments").setup {}
        end
    }

    -- Lsp
    use {
        'VonHeikemen/lsp-zero.nvim',
        branch = 'v1.x',
        requires = {
            -- LSP Support
            {'neovim/nvim-lspconfig'},             -- Required
            {                                      -- Optional
                'williamboman/mason.nvim',
                run = function()
                    pcall(vim.cmd, 'MasonUpdate')
                end,
            },
            {'williamboman/mason-lspconfig.nvim'}, -- Optional

            -- Autocompletion
            {'hrsh7th/nvim-cmp'},         -- Required
            {'hrsh7th/cmp-nvim-lsp'},     -- Required
            {'hrsh7th/cmp-buffer'},       -- Optional
            {'hrsh7th/cmp-path'},         -- Optional
            {'saadparwaiz1/cmp_luasnip'}, -- Optional
            {'hrsh7th/cmp-nvim-lua'},     -- Optional

            -- Snippets
            {'L3MON4D3/LuaSnip'},             -- Required
            {'rafamadriz/friendly-snippets'}, -- Optional
        }
    }

    -- lualine
    use {
        'nvim-lualine/lualine.nvim',
        requires = { 'nvim-tree/nvim-web-devicons', opt = true },
        config = function()
          require('lualine').setup({
            sections = {
                lualine_c = {
                    {
                        'filename',
                        path = 1 -- 0 = just filename, 1 = relative path, 2 = absolute path
                    },
                }
            }
        })
        end
    }

    -- Git stuff
    use {
        'lewis6991/gitsigns.nvim',
        config = function()
            require('gitsigns').setup()
        end
    }
    use { 'sindrets/diffview.nvim' }

    use {'rcarriga/nvim-notify'}

    use {
        "windwp/nvim-autopairs",
        config = function() require("nvim-autopairs").setup {} end
    }

    use {'windwp/nvim-ts-autotag'}

    use { 'sourcegraph/sg.nvim', run = 'nvim -l build/init.lua' }

    use {
        'lvimuser/lsp-inlayhints.nvim',
        config = function()
            require('lsp-inlayhints').setup()
        end
    }

    -- Automatically set up your configuration after cloning packer.nvim
    -- Put this at the end after all plugins
    if packer_bootstrap then
        require('packer').sync()
    end
end)
