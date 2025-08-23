export const metadata = {
  title: 'Windsoft ArtBundle Studio',
  description: 'Collage + Video builder (Full)'
};
import './globals.css';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
