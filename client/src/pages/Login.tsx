import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { login, register } = useAuth()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      if (isRegister) {
        await register(username, email, password, displayName || username)
      } else {
        await login(email, password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Relay</h1>
        <p className="login-subtitle">{isRegister ? 'Create an account' : 'Welcome back'}</p>

        <form onSubmit={handleSubmit}>
          {isRegister && (
            <>
              <label>
                Username
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="username"
                />
              </label>
              <label>
                Display Name
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                  autoComplete="name"
                />
              </label>
            </>
          )}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
            />
          </label>

          {error && <p className="error">{error}</p>}

          <button type="submit">{isRegister ? 'Register' : 'Login'}</button>
        </form>

        <p className="login-toggle">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button type="button" className="link-btn" onClick={() => setIsRegister(!isRegister)}>
            {isRegister ? 'Login' : 'Register'}
          </button>
        </p>
      </div>
    </div>
  )
}
