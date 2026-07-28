"""Busy-spin one CPU core to simulate a Beckett worker under load.

Runs a tight numpy matmul loop so the work can't be optimised away and the
core sits pinned at ~100%. Started/stopped by benchmark.py around the
"loaded" measurement pass. Runs until killed.
"""
import numpy as np

a = np.random.rand(256, 256)
b = np.random.rand(256, 256)
while True:
    a = (a @ b) * 0.5 + 0.5
