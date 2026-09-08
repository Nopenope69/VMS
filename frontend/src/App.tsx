import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import LiveView from './pages/LiveView';
import Playback from './pages/Playback';
import Devices from './pages/Devices';
import Events from './pages/Events';
import Evidence from './pages/Evidence';
import Users from './pages/Users';
import AuditLogs from './pages/AuditLogs';
import License from './pages/License';
import AnprConsole from './pages/AnprConsole';
import FederationConsole from './pages/FederationConsole';
import Investigation from './pages/Investigation';
import FloorplanView from './pages/FloorplanView';
import IdentitySettings from './pages/IdentitySettings';
import Login from './pages/Login';
import api from './services/api';

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('vigilone_token'));
  const [user, setUser] = useState<any | null>(null);
  const [currentTab, setCurrentTab] = useState('live');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedUser = localStorage.getItem('vigilone_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {}
    }

    if (token) {
      api
        .get('/auth/me')
        .then((res) => {
          setUser(res.data.user);
          localStorage.setItem('vigilone_user', JSON.stringify(res.data.user));
        })
        .catch(() => {
          handleLogout();
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [token]);

  const handleLoginSuccess = (userData: any, userToken: string) => {
    localStorage.setItem('vigilone_token', userToken);
    localStorage.setItem('vigilone_user', JSON.stringify(userData));
    setToken(userToken);
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem('vigilone_token');
    localStorage.removeItem('vigilone_user');
    setToken(null);
    setUser(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-graphite-900 flex items-center justify-center text-slate-400 font-mono text-xs">
        Initializing VigilOne Surveillance Appliance...
      </div>
    );
  }

  if (!token || !user) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-graphite-900 flex flex-col font-sans text-slate-100">
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        user={user}
        onLogout={handleLogout}
      />

      <main className="flex-1">
        {currentTab === 'live' && (
          <LiveView
            onNavigateToDevices={() => setCurrentTab('devices')}
            onNavigateToAlarms={() => setCurrentTab('events')}
          />
        )}
        {currentTab === 'playback' && <Playback />}
        {currentTab === 'investigation' && <Investigation />}
        {currentTab === 'floorplans' && <FloorplanView />}
        {currentTab === 'devices' && <Devices />}
        {currentTab === 'anpr' && <AnprConsole />}
        {currentTab === 'events' && <Events />}
        {currentTab === 'evidence' && <Evidence />}
        {currentTab === 'identity' && <IdentitySettings />}
        {currentTab === 'federation' && <FederationConsole />}
        {currentTab === 'users' && <Users />}
        {currentTab === 'audit' && <AuditLogs />}
        {currentTab === 'license' && <License />}
      </main>
    </div>
  );
};

export default App;
