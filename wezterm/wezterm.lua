-- Pull in the wezterm API
local wezterm = require 'wezterm'

-- This will hold the configuration.
local config = wezterm.config_builder()

-- General Settings
config.automatically_reload_config = true

-- Color Scheme
config.color_scheme = 'Catppuccin Mocha'

-- Font
config.font_size = 14
config.font =
    wezterm.font('GeistMono Nerd Font Mono', { weight = 'Bold' })

-- Display
config.enable_tab_bar = false
config.window_decorations = 'RESIZE'
config.window_padding = {
  -- left = 0,
  right = 0,
  top = 0,
  bottom = 0,
}

-- Make Option-Left and Option-Right go back or forward a word
config.keys = {
  { key = 'LeftArrow',  mods = 'OPT', action = wezterm.action.SendString '\x1bb' },
  { key = 'RightArrow', mods = 'OPT', action = wezterm.action.SendString '\x1bf' },
  { key = 'w',          mods = 'CMD', action = wezterm.action.DisableDefaultAssignment },
}

-- Maximize window on startup
-- https://wezfurlong.org/wezterm/config/lua/gui-events/gui-startup.html
local mux = wezterm.mux
wezterm.on('gui-startup', function(cmd)
  local _, _, window = mux.spawn_window(cmd or {})
  window:gui_window():maximize()
end)
--

-- and finally, return the configuration to wezterm
return config
