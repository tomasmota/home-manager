return {
  {
    'lewis6991/gitsigns.nvim',
    lazy = false,
    opts = {
      signs = {
        add = { text = '+' },
        change = { text = '~' },
        delete = { text = '_' },
        topdelete = { text = '‾' },
        changedelete = { text = '~' },
      },
      on_attach = function(buffer)
        local gs = package.loaded.gitsigns

        local function map(mode, l, r, desc)
          vim.keymap.set(mode, l, r, { buffer = buffer, desc = desc })
        end

        -- stylua: ignore start
        map("n", "]h", gs.next_hunk, "Next Hunk")
        map("n", "[h", gs.prev_hunk, "Prev Hunk")
        map({ "n", "v" }, "<leader>hs", ":Gitsigns stage_hunk<CR>", "Stage Hunk")
        map({ "n", "v" }, "<leader>hr", ":Gitsigns reset_hunk<CR>", "Reset Hunk")
        map("n", "<leader>hp", gs.preview_hunk, "Preview Hunk")
        map({ "o", "x" }, "ih", ":<C-U>Gitsigns select_hunk<CR>", "GitSigns Select Hunk")
      end,
    },
  },
  {
    'sindrets/diffview.nvim',
    config = true,
    lazy = false,
    keys = {
      { "<leader>gd", ":DiffviewOpen<CR>" },
      { "<leader>gD", ":DiffviewOpen HEAD~1<CR>" },
      { "<leader>gc", ":DiffviewClose<CR>" },
      { "<leader>gh", ":DiffviewFileHistory %<CR>" },
      { "<leader>gH", ":DiffviewFileHistory<CR>" },
      { "<C-\\>",     ":DiffviewToggleFiles<CR>" },
    },
  },
  {
    'linrongbin16/gitlinker.nvim',
    config = function()
      require('gitlinker').setup({
        message = false,
        highlight_duration = 200
      })

      vim.keymap.set(
        { "n", "v" },
        "<leader>gy",
        function()
          require("gitlinker").link()
        end,
        { silent = true, noremap = true, desc = "Yank git link (current rev, with lines)" }
      )

      vim.keymap.set(
        { "n", "v" },
        "<leader>gL",
        function()
          require("gitlinker").link({
            router = function(lk)
              local builder = "https://" .. lk.host .. "/"
              builder = builder .. lk.org .. "/"
              builder = builder .. (lk.repo:match("(.+)%.git$") or lk.repo) .. "/blob/"
              builder = builder .. (lk.default_branch or "main") .. "/"
              builder = builder .. lk.file
              return builder
            end
          })
        end,
        { silent = true, noremap = true, desc = "Yank git link (main branch, no lines)" }
      )

      vim.keymap.set(
        { "n", "v" },
        "<leader>gl",
        function()
          require("gitlinker").link({
            router = function(lk)
              local builder = "https://" .. lk.host .. "/"
              builder = builder .. lk.org .. "/"
              builder = builder .. (lk.repo:match("(.+)%.git$") or lk.repo) .. "/blob/"
              builder = builder .. lk.rev .. "/"
              builder = builder .. lk.file
              return builder
            end
          })
        end,
        { silent = true, noremap = true, desc = "Yank git link (current rev, no lines)" }
      )
    end,
  },
}
