const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: process.env.NODE_ENV || 'development',
  entry: './renderer/src/index.jsx',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'renderer/dist'),
    filename: 'bundle.js',
    publicPath: './',
    clean: true,
  },
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react'],
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(png|jpg|gif|svg|ico)$/,
        type: 'asset/resource',
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './renderer/src/index.html',
      filename: 'index.html',
    }),
  ],
  devServer: {
    port: 9000,
    hot: true,
    static: {
      directory: path.join(__dirname, 'renderer/dist'),
    },
  },
};
