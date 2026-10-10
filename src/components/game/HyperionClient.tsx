'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HyperionGame } from './engine/game';
import { HUD_INITIAL, HudState } from './engine/types';
import { Hud } from './hud';
import { initIcons, initUIIcons } from './engine/items';
import { hasSave } from './engine/save';

export default function HyperionClient() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<HyperionGame | null>(null);
  // Seed hasSave at first paint so the CONTINUE button never pops in late.
  const [state, setState] = useState<HudState>(() => ({ ...HUD_INITIAL, hasSave: hasSave() }));
  const [toast, setToast] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(true);
  const [paused, setPaused] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    initIcons();
    initUIIcons();
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Register the minimap canvas once the HUD mounts it.
    const minimapTimer = setInterval(() => {
      if (disposed) return;
      const c = document.getElementById('hyperion-minimap') as HTMLCanvasElement | null;
      gameRef.current?.setMinimap(c);
    }, 1000);

    // Let the loading UI paint before the heavy city generation blocks the main thread.
    const t = setTimeout(() => {
      if (disposed) return;
      try {
        const game = new HyperionGame(canvas, {
          onState: (s) => setState(s),
          onToast: (msg) => {
            if (msg === '__OPEN_INVENTORY__') {
              setInventoryOpen((prev) => {
                const next = !prev;
                game.setUiOpen(next);
                if (next) game.inputExitLock();
                else game.requestLock();
                return next;
              });
              return;
            }
            setToast(msg);
          },
          onDeath: () => {
            game.inputExitLock();
          },
          onPauseRequest: () => {
            setPaused(true);
            game.setPaused(true);
            game.inputExitLock();
          },
        });
        gameRef.current = game;
        // Expose for browser-automation QA (harmless in production).
        (window as unknown as { __hyperion?: HyperionGame }).__hyperion = game;
        game.start();
        setLoading(false);
      } catch (err) {
        setFatal(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }, 60);

    return () => {
      disposed = true;
      clearTimeout(t);
      clearInterval(minimapTimer);
      gameRef.current?.dispose();
      gameRef.current = null;
    };
  }, []);

  const handlePlay = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    game.resetNewGame(); // fresh run: wipe any previous save
    setShowStart(false);
    setPaused(false);
    game.setPlaying(true);
    game.setPaused(false);
    game.requestLock();
  }, []);

  const handleContinue = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    game.applySave();
    setShowStart(false);
    setPaused(false);
    game.setPlaying(true);
    game.setPaused(false);
    game.requestLock();
  }, []);

  const handleSave = useCallback(() => {
    gameRef.current?.saveNow(true);
  }, []);

  const handleResume = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    setPaused(false);
    game.setPaused(false);
    game.requestLock();
  }, []);

  const handleRespawn = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    game.respawn();
    game.requestLock();
  }, []);

  const handleSlotClick = useCallback((i: number) => {
    gameRef.current?.setSlot(i);
  }, []);

  const handleInventorySwap = useCallback((i: number) => {
    gameRef.current?.swapInventorySlot(i);
  }, []);

  const handleCloseInventory = useCallback(() => {
    setInventoryOpen(false);
    gameRef.current?.setUiOpen(false);
    gameRef.current?.requestLock();
  }, []);

  // Pause when pointer lock is lost mid-play (unless a UI panel is open)
  useEffect(() => {
    const onLockChange = () => {
      const game = gameRef.current;
      if (!game) return;
      if (!document.pointerLockElement && !showStart && !inventoryOpen && !state.dead && game.playing) {
        setPaused(true);
        game.setPaused(true);
      }
      if (game.lockFailed && !showStart) {
        setToast('Pointer lock unavailable — hold a mouse button and drag to look');
      }
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [showStart, inventoryOpen, state.dead]);

  return (
    <div className="fixed inset-0 bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <Hud
        state={state}
        toast={toast}
        onSlotClick={handleSlotClick}
        onInventorySwap={handleInventorySwap}
        onResume={handleResume}
        onRespawn={handleRespawn}
        onPlay={handlePlay}
        onContinue={handleContinue}
        onSave={handleSave}
        paused={paused}
        inventoryOpen={inventoryOpen}
        onCloseInventory={handleCloseInventory}
        showStart={showStart}
      />
      {loading && (
        <div className="fixed inset-0 flex items-center justify-center bg-[#0b0b0d]">
          <div className="text-center font-mono">
            <div className="mb-4 text-4xl font-black italic tracking-tighter text-white">
              PROJECT <span className="text-amber-400">HYPERION</span>
            </div>
            <div className="h-1.5 w-64 overflow-hidden rounded bg-white/10">
              <div className="h-full w-1/3 animate-pulse rounded bg-amber-400" />
            </div>
            <div className="mt-4 text-xs uppercase tracking-[0.3em] text-white/60">
              Slicing the city into micro-voxels…
            </div>
          </div>
        </div>
      )}
      {fatal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black p-8">
          <div className="max-w-md rounded-lg border border-red-500/30 bg-red-950/40 p-6 text-center font-mono">
            <div className="mb-2 text-lg font-bold text-red-300">Engine failed to start</div>
            <div className="text-xs text-red-200/80">{fatal}</div>
            <div className="mt-3 text-[11px] text-white/50">WebGL2 support is required.</div>
          </div>
        </div>
      )}
    </div>
  );
}
