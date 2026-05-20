"""
User-site customisation that injects the Clawd lock-screen widget into
cinnamon-screensaver without touching any system files.

Mechanism:
  Python imports this module automatically (via the 'site' module) every time
  a python3 process starts. We check sys.argv[0] — if we're inside
  cinnamon-screensaver-main.py we register a meta_path finder. When that
  process later imports the 'stage' module, the finder patches the Stage
  class so it creates a ClawdWidget. For any other Python program we exit
  immediately.

  The widget itself lives at:
    ~/.local/lib/python3.12/site-packages/clawd_widget_user.py
  (Distinct name from the legacy /usr/share file so there's no clash if
  both are present — we always use ours via explicit import.)

  Toggle on/off via the Cinnamon panel applet, which writes:
    ~/.config/clawd-lockscreen/enabled
"""

import os
import sys


def _in_cinnamon_screensaver():
    argv0 = sys.argv[0] if sys.argv else ""
    return "cinnamon-screensaver-main" in (argv0 or "")


if _in_cinnamon_screensaver():
    try:
        import importlib.abc

        class _ClawdStagePatcher(importlib.abc.MetaPathFinder):
            def __init__(self):
                self._patched = False

            def find_spec(self, fullname, path, target=None):
                if fullname != "stage" or self._patched:
                    return None
                spec = None
                for finder in sys.meta_path:
                    if finder is self:
                        continue
                    find = getattr(finder, "find_spec", None)
                    if find is None:
                        continue
                    try:
                        spec = find(fullname, path, target)
                    except Exception:
                        spec = None
                    if spec is not None:
                        break
                if spec is None or spec.loader is None:
                    return None

                original_exec = spec.loader.exec_module
                patcher = self

                def exec_module(module):
                    original_exec(module)
                    try:
                        patcher._patch_stage(module)
                        patcher._patched = True
                    except Exception as e:
                        sys.stderr.write("Clawd usercustomize patch failed: %s\n" % e)

                spec.loader.exec_module = exec_module
                return spec

            def _make_setup_clawd(self):
                """Return a method that creates Clawd using our user-site widget."""

                def setup_clawd(stage_self):
                    if os.environ.get("CLAWD_LOCKSCREEN", "1") == "0":
                        stage_self.clawd_widget = None
                        return
                    try:
                        from clawd_widget_user import ClawdWidget
                    except Exception as e:
                        sys.stderr.write("Clawd user widget unavailable: %s\n" % e)
                        stage_self.clawd_widget = None
                        return
                    try:
                        import status as _status
                        mon = _status.screen.get_mouse_monitor()
                    except Exception:
                        mon = 0
                    try:
                        widget = ClawdWidget(mon)
                        stage_self.add_child_widget(widget)
                        widget.show()
                        if not hasattr(stage_self, "floaters"):
                            stage_self.floaters = []
                        stage_self.floaters.append(widget)
                        stage_self.clawd_widget = widget
                    except Exception as e:
                        sys.stderr.write("Clawd setup failed: %s\n" % e)
                        stage_self.clawd_widget = None

                return setup_clawd

            def _patch_stage(self, stage_module):
                Stage = getattr(stage_module, "Stage", None)
                if Stage is None or getattr(Stage, "_clawd_user_patched", False):
                    return

                # Always replace (or install) setup_clawd with our user-widget version.
                # If the legacy system patch is in place, this hijacks its setup_clawd
                # call so it ends up creating our widget rather than the legacy one.
                Stage.setup_clawd = self._make_setup_clawd()

                # If the legacy system patch isn't in place, setup_delayed_components
                # never calls setup_clawd. Wrap it so we still create the widget.
                original = Stage.setup_delayed_components

                def wrapped(stage_self, data=None):
                    try:
                        original(stage_self, data)
                    except Exception:
                        raise
                    # If nothing has created a widget yet, do it now.
                    if getattr(stage_self, "clawd_widget", None) is None:
                        try:
                            stage_self.setup_clawd()
                        except Exception as e:
                            sys.stderr.write("Clawd post-setup failed: %s\n" % e)

                Stage.setup_delayed_components = wrapped
                Stage._clawd_user_patched = True

        sys.meta_path.insert(0, _ClawdStagePatcher())
    except Exception as _e:
        sys.stderr.write("Clawd usercustomize bootstrap failed: %s\n" % _e)
