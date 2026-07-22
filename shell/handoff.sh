# claude-handoff — open a session on the recap instead of a blank prompt.
#
# Claude Code's SessionStart hook can only inject context; it cannot make Claude
# speak first (the hooks docs are explicit: SessionStart is "context only, no
# blocking or decision control"). The recap lands in context and then waits for
# you to type something before anything renders.
#
# Passing a first prompt on the command line does make Claude speak first — the
# session still opens interactive, but with that turn already submitted, and the
# hook's recap rides along with it. So this wraps `claude` to supply that prompt
# when, and only when, there is nothing else to say.
#
# Escape hatches:
#   claude --raw ...              run the real binary untouched
#   HANDOFF_NO_AUTOSTART=1        disable for a shell or a single command
#   HANDOFF_OPENING_PROMPT="..."  use your own opening prompt

# True when $PWD or one of its parents is a handoff-tracked project.
__handoff_tracked() {
  local dir="$PWD"
  while [ -n "$dir" ]; do
    [ -d "$dir/.handoff" ] && return 0
    [ "$dir" = "/" ] && break
    dir="${dir%/*}"
    [ -z "$dir" ] && dir="/"
  done
  return 1
}

claude() {
  if [ "$1" = "--raw" ]; then
    shift
    command claude "$@"
    return
  fi

  # Only a bare `claude` gets the opening prompt. Anything with arguments —
  # a prompt, --continue, --resume, -p — is already saying what it wants.
  if [ "$#" -eq 0 ] && [ -z "$HANDOFF_NO_AUTOSTART" ] && __handoff_tracked; then
    command claude "${HANDOFF_OPENING_PROMPT:-Where did we leave off?}"
    return
  fi

  command claude "$@"
}
