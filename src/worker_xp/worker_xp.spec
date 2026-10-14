# -*- mode: python ; coding: utf-8 -*-
# PyInstaller Spec for Windows XP (Win32) Standalone Worker Package
# Target: Windows XP SP3 (x86) + Python 3.4.4 (x86) / Python 2.7 (x86) + PyInstaller 3.2.1
# Output Mode: onedir (Self-contained directory package)

import sys
import os

block_cipher = None

added_files = []
if os.path.exists('coordinator.defaults.json'):
    added_files.append(('coordinator.defaults.json', '.'))
if os.path.exists('version.json'):
    added_files.append(('version.json', '.'))

a = Analysis(
    ['worker_xp.py'],
    pathex=['.'],
    binaries=[],
    datas=added_files,
    hiddenimports=[
        'win32com',
        'win32com.client',
        'win32print',
        'config_manager_xp',
        'printer_engine_xp',
        'word_engine_xp'
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'scipy', 'numpy', 'IPython'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name='worker_xp',
    debug=False,
    strip=False,
    upx=False,
    console=True
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='worker_xp'
)
