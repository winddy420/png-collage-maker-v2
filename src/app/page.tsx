import dynamic from 'next/dynamic';
const ArtBundleStudio = dynamic(() => import('@/components/ArtBundleStudio'), { ssr: false });
export default function Page(){ return <ArtBundleStudio/> }
