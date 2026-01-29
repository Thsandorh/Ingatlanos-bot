import "./globals.css";

export const metadata = {
  title: "Ingatlan Lead Engine",
  description: "Serverless lead monitoring for ingatlan.com"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
