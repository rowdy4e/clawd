// Clawd — preferences window. GNOME 45+ uses libadwaita (Adw) widgets.
// Opened via Extension Manager "Settings" button or `gnome-extensions prefs clawd@rowdy4e`.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

const ANIMATION_LABELS = [
    ['random',  'Random'],
    ['bounce',  'Bounce'],
    ['wiggle',  'Wiggle'],
    ['squish',  'Squish'],
    ['spin',    'Spin'],
    ['shake',   'Shake'],
    ['tilt',    'Tilt'],
    ['walk',    'Walk'],
    ['excited', 'Excited'],
    ['morph',   'Morph'],
    ['glitch',  'Glitch'],
    ['rainbow', 'Rainbow (recolors Clawd!)'],
];

const BAR_LABELS = [
    ['session',     'Session (5h limit)'],
    ['week',        'Week (all models)'],
    ['week-sonnet', 'Week (Sonnet only)'],
    ['credits',     'Extra credits'],
];

function buildComboRow(title, choices, settings, key) {
    const model = new Gtk.StringList();
    for (const [, label] of choices) model.append(label);

    const row = new Adw.ComboRow({title, model});
    const current = settings.get_string(key);
    const idx = Math.max(0, choices.findIndex(([k]) => k === current));
    row.set_selected(idx);

    row.connect('notify::selected', () => {
        const sel = row.get_selected();
        if (sel >= 0 && sel < choices.length) {
            settings.set_string(key, choices[sel][0]);
        }
    });
    // React if the value is changed externally (e.g. dconf-editor).
    settings.connect(`changed::${key}`, () => {
        const v = settings.get_string(key);
        const i = choices.findIndex(([k]) => k === v);
        if (i >= 0 && i !== row.get_selected()) row.set_selected(i);
    });
    return row;
}

function buildSpinRow(title, subtitle, settings, key, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle: subtitle || '',
        adjustment: new Gtk.Adjustment({
            lower: min, upper: max,
            step_increment: step, page_increment: step * 10,
        }),
    });
    settings.bind(key, row, 'value', 0); // Gio.SettingsBindFlags.DEFAULT = 0
    return row;
}

function buildSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle || ''});
    settings.bind(key, row, 'active', 0);
    return row;
}

export default class ClawdPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.clawd');

        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ─── Display ───
        const display = new Adw.PreferencesGroup({title: 'Display'});
        display.add(buildSpinRow(
            'Refresh interval', 'Seconds between usage refreshes (auto-backs-off on 429)',
            settings, 'refresh-seconds', 60, 7200, 30));
        display.add(buildComboRow('Progress bar shows', BAR_LABELS, settings, 'bar-mode'));
        page.add(display);

        // ─── Animation ───
        const animation = new Adw.PreferencesGroup({title: 'Animation'});
        animation.add(buildComboRow('Animation style', ANIMATION_LABELS, settings, 'animation-style'));
        animation.add(buildSwitchRow(
            'Animate on refresh', 'Play an animation each time usage refreshes',
            settings, 'animate-on-refresh'));
        animation.add(buildSwitchRow(
            'Idle animations', 'Clawd reacts on his own at random intervals',
            settings, 'idle-animations'));
        animation.add(buildSpinRow(
            'Idle minimum', 'Shortest interval between idle animations (s)',
            settings, 'idle-min-seconds', 3, 600, 1));
        animation.add(buildSpinRow(
            'Idle maximum', 'Longest interval between idle animations (s)',
            settings, 'idle-max-seconds', 5, 1200, 1));
        page.add(animation);

        // ─── Advanced ───
        const advanced = new Adw.PreferencesGroup({title: 'Advanced'});
        advanced.add(buildSwitchRow(
            'Animation playground', 'Adds a submenu that lets you trigger every animation by hand',
            settings, 'dev-mode'));
        page.add(advanced);
    }
}
