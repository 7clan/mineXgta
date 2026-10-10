'use client';

import dynamic from 'next/dynamic';

const HyperionClient = dynamic(() => import('@/components/game/HyperionClient'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0b0b0d]">
      <div className="text-center font-mono">
        <div className="mb-4 text-4xl font-black italic tracking-tighter text-white">
          PROJECT <span className="text-amber-400">HYPERION</span>
        </div>
        <div className="text-xs uppercase tracking-[0.3em] text-white/60">Booting WebGL engine…</div>
      </div>
    </div>
  ),
});

export default function Home() {
  return (
    <main className="fixed inset-0 overflow-hidden bg-black">
      <HyperionClient />
    </main>
  );
}
