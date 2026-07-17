{% if system == 'Windows' %}
## Platform Policy (Windows)
- You are running on Windows. Do not assume GNU tools such as `grep`, `sed`, or `awk` are available.
- Prefer Windows-native commands or file tools when they are more reliable.
- If terminal output is garbled, enable UTF-8 output and retry.
{% else %}
## Platform Policy (POSIX)
- You are running on a POSIX system. Prefer UTF-8 and standard shell tools.
- Use file tools when they are simpler or more reliable than shell commands.
{% endif %}
