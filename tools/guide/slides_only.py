"""把 .tmp/video2/install-slides 的 6 张安装示意图转成教程 webp（不截图）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture_full

capture_full.slides_to_webp()
