// Clawd — preferences window. GNOME 45+ uses libadwaita (Adw) widgets.
// Opened via Extension Manager "Settings" button or `gnome-extensions prefs clawd@rowdy4e`.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LOCKSCREEN_CONFIG_DIR = GLib.get_home_dir() + '/.config/clawd-lockscreen';
const LOCKSCREEN_MESSAGES_FILE = LOCKSCREEN_CONFIG_DIR + '/messages';

// Defaults seeded into the messages file on first edit. Kept in sync with the
// Cinnamon applet so the shared config file is interchangeable.
const DEFAULT_LOCKSCREEN_MESSAGES = [
    "You're absolutely right!",
    "Let me think about this more carefully...",
    "Actually, on reflection — yes, that.",
    "Hmm, you raise a good point.",
    "404: Motivation not found.",
    "It works on my machine ¯\\_(ツ)_/¯",
    "Just one more refactor, I promise.",
    "TODO: rename this variable later.",
    "git push --force or die trying.",
    "Have you tried turning it off and on again?",
    "Stack Overflow is your spirit animal.",
    "Naming things is hard.",
    "There are 2 hard problems: cache invalidation, naming things, off-by-one errors.",
    "Today's bug is tomorrow's feature.",
    "Code never lies. Comments sometimes do.",
    "Make it work, make it right, make it fast.",
    "Premature optimization is the root of all evil.",
    "Why do programmers prefer dark mode? Bugs hate the light.",
    "There's no place like 127.0.0.1",
    "I'd tell you a UDP joke, but you might not get it.",
    "A SQL query walks into a bar — sees two tables — asks: mind if I join you?",
    "Take a deep breath. The compiler can wait.",
    "Did you remember to commit?",
    "Sip your coffee. The bug will still be there.",
    "Step away for 5 minutes. Solutions appear in the shower.",
];

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

function buildButtonRow(title, subtitle, buttonLabel, onClick) {
    const row = new Adw.ActionRow({title, subtitle: subtitle || ''});
    const btn = new Gtk.Button({
        label: buttonLabel,
        valign: Gtk.Align.CENTER,
    });
    btn.connect('clicked', onClick);
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

function _writeDefaultMessages() {
    try {
        GLib.mkdir_with_parents(LOCKSCREEN_CONFIG_DIR, parseInt('755', 8));
        const text = DEFAULT_LOCKSCREEN_MESSAGES.join('\n') + '\n';
        GLib.file_set_contents(LOCKSCREEN_MESSAGES_FILE, text);
    } catch (e) {
        console.warn('Clawd: reset messages failed: ' + e);
    }
}

function _openMessagesEditor() {
    try {
        if (!GLib.file_test(LOCKSCREEN_MESSAGES_FILE, GLib.FileTest.EXISTS)) {
            _writeDefaultMessages();
        }
        Gio.Subprocess.new(['xdg-open', LOCKSCREEN_MESSAGES_FILE], Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.warn('Clawd: open messages editor failed: ' + e);
    }
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

        // ─── Lock screen ───
        const lock = new Adw.PreferencesGroup({title: 'Lock screen'});
        lock.add(buildSwitchRow(
            'Show Clawd on lock screen',
            'Animated mascot with a rotating speech bubble and a rare grow easter egg',
            settings, 'lockscreen-enabled'));
        lock.add(buildSwitchRow(
            'Position at bottom',
            'Off = anchor below the top panel instead',
            settings, 'lockscreen-position-bottom'));
        lock.add(buildSpinRow(
            'Clawd size', 'Percentage — 100 % = auto-fit to monitor (~5 % of width)',
            settings, 'lockscreen-size-percent', 50, 200, 10));
        lock.add(buildButtonRow(
            'Edit lock-screen messages…',
            'Speech bubbles Clawd shows on the lock screen (one per line).',
            'Open',
            () => _openMessagesEditor()));
        lock.add(buildButtonRow(
            'Reset to default messages',
            'Overwrite the messages file with the bundled defaults.',
            'Reset',
            () => _writeDefaultMessages()));
        page.add(lock);

        // ─── Advanced ───
        const advanced = new Adw.PreferencesGroup({title: 'Advanced'});
        advanced.add(buildSwitchRow(
            'Animation playground', 'Adds a submenu that lets you trigger every animation by hand',
            settings, 'dev-mode'));
        page.add(advanced);
    }
}
