import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.terrasense.app',
  appName: 'TerraSense',
  webDir: 'dist',

  plugins: {
    FirebaseAuthentication: {
      providers: ['google.com']
    }
  }
};

export default config;